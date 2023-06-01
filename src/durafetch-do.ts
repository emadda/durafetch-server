import * as _ from "lodash";
import {
    get_worker_name,
    is_auth_valid,
    starts_with_ext_subdomain,
    res_not_authorised,
    get_internal_req_hostname
} from "./util";
import {log} from "./log";

const is_websocket_upgrade = (request) => {
    return request.headers.get('Upgrade') === "websocket";
}


const json_res = (obj, opts = {}) => {
    const o = _.merge(
        {
            headers: {
                'content-type': 'application/json',
                // ...cors_headers
            }
        },
        opts
    );

    const r = new Response(JSON.stringify(obj), o);
    return r;
};


const to_do_key = (durable_object_id) => {
    return `do-key.${durable_object_id}`;
}

const get_do_stub = (env, do_class_name, name) => {
    const o = env[do_class_name];
    const id_do = o.idFromName(name);
    return o.get(id_do);
}

const get_do_stub_from_id = (env, do_class_name, id_do) => {
    const o = env[do_class_name];
    const id = o.idFromString(id_do);
    return o.get(id);
}

class DURAFETCH_DO {
    constructor(state, env) {
        // ADMIN_DO
        // this.constructor.name
        this.state = state;
        this.env = env;


    }

    // Server side web socket connection.
    ws_get_and_watch_durable_object_index = [];
    state: DurableObjectState

    async fetch(req: Request) {
        const url = new URL(req.url);

        // External requests (from the internet).
        if (starts_with_ext_subdomain(this.env, req)) {
            if (!is_auth_valid(this.env, req)) {
                return res_not_authorised();
            }


            // Worker forwards upgrade from public request, durable object keeps server side websocket in state.
            // @todo/low In prod, force wss:// (TLS).
            if (is_websocket_upgrade(req)) {

                // Get list of durable object names, watch for changes.
                if (url.pathname === "/external/do/get_and_watch_index") {
                    return this.start_websocket_get_and_watch_durable_object_index();
                }


                // Read all key and values from a specific durable object, stream chunks over ws, close after completion.
                if (url.pathname === "/external/do/read_all_from") {
                    return this.process_external_do_read_all_from(req);
                }
            }


            if (req.method === "POST") {
                // Delete the list of durable objects (but not the objects themselves).
                // - Used for testing.
                if (url.pathname === "/external/do/delete_all") {
                    await this.state.storage.deleteAll();
                    const all = [...(await this.state.storage.list())];
                    console.log("Deleted all keys in DURAFETCH_DO", JSON.stringify(all));
                    return json_res({ok: true});
                }
            }


            return new Response(`Unknown action.`, {status: 400});
        }


        // Internal requests (direct from another worker using DO stub).
        if (url.hostname === get_internal_req_hostname()) {
            if (req.method === "POST") {
                if (url.pathname === "/internal/do/started") {
                    return this.process_internal_do_started(req);
                }

                if (url.pathname === "/internal/do/new_cur_write_id") {
                    return this.process_internal_do_new_cur_write_id(req);
                }
            }
        }


        return new Response(`Unknown action.`, {status: 400});
    }

    async process_external_do_read_all_from(req) {
        const url = new URL(req.url);

        const {
            worker_name = null,
            class_name = null,
            name = null,
            id = null,

            from_write_id = null,
            from_write_log_id = null,

            // @todo/med Array of regex filters to match (worker_name, class_name, name, key). Send to DO to filter on read.
            filters = null
        } = _.fromPairs([...url.searchParams]);

        const is_valid = (
            _.isString(worker_name) &&
            _.isString(class_name) &&
            _.isString(id) &&
            worker_name === get_worker_name() &&
            (class_name in this.env)
        );
        if (!is_valid) {
            // Each worker has its own DURAFETCH_DO instance - this prevents using service bindings to do cross worker requests.
            // - Each DURAFETCH_DO reads the durable objects within it's parent worker namespace. Each has its own subdomain. The client will download from each subdomain into a single DB.
            return json_res({
                ok: false,
                msg: "Provide query params with worker_name, class_name and name (of the durable object). Worker name must match the one that handles the HTTP request."
            }, {status: 400});
        }


        // The client connects to the DO directly with a websocket connection.
        // - It will either:
        // - 1. Read all (read all state from the DO).
        // - 2. Read all since X (read all since a write_id - client already has a previous download up to that write_id).
        //
        // A websocket connection is used because:
        // - `ws.send()` is sync
        //      - Allows moving data from the JS process (in the case that the DO has too much data to store in the 128MB RAM limit).
        //      - Does not break the "read tx" that is implicit to DO's (await points implicitly break read tx's).
        //
        // The websocket connection ends after the download:
        // - 1. Avoid keeping it alive to reduce costs.
        // - 2. When an end user connects, it will be re-started geographically close to them.
        // - For watching for changes, DO's will HTTP POST to this process which will then route down a ws, which prevents points 1 and 2.
        const stub = await get_do_stub_from_id(this.env, class_name, id);
        return stub.fetch(req);
    }


    async process_internal_do_started(req) {
        const {obj, cur_write_id} = await req.json();

        const is_valid = (
            _.isString(obj.worker_name) &&
            _.isString(obj.class_name) &&
            _.isString(obj.id)
        );

        if (!is_valid) {
            return new Response(`Invalid request. Include worker_name, class_name and id.`, {status: 400});
        }

        const do_key = to_do_key(obj.id);

        // @todo/low Communicate deletes: Objects can be deleted via wrangler.toml config. Can this be detected and removed from this index?
        // @todo/high Do not overwrite a string name with null (in the case the same durable object is referenced by name, and then later by id).
        const val = {obj, cur_write_id};
        this.state.storage.put(do_key, val);

        // @todo/low Remove this as full lists are being downloaded instead and diffed by the client?
        // Notify watchers.
        // - When a new durable object is created they:
        // - 1. Connect and retrieve the initial state.
        // - 2. Watch for any new writes via a WS to DURAFETCH_DO (which receives POST requests from each DO).
        for (const server of this.ws_get_and_watch_durable_object_index) {
            server.send({
                kind: "partial_index",
                durable_object_list: [val]
            })
        }

        return json_res({ok: true});
    }

    async process_internal_do_new_cur_write_id(req) {
        const body = await req.json();
        const id = body.meta.id;
        const key = to_do_key(id);
        const v = await this.state.storage.get(key);
        if (v === undefined) {
            const msg = `Key ${key} does not exist in DURAFETCH_DO, but it should at this point as it is being updated with the current write_id (after the durable object has been started which should create this key) ${JSON.stringify(body)}.`
            log.error(msg);
            throw Error(msg);
        }

        v.cur_write_id = body.cur_write_id;
        this.state.storage.put(key, v);
        // @todo/high Send partial_index of durable object listing to all ws listening on `this.ws_get_and_watch_durable_object_index`.

        return json_res({ok: true});
    }


    // Return the full list of durable objects ID's on first connect.
    // After that, send any new durable objects ID's that get created.
    start_websocket_get_and_watch_durable_object_index() {
        log.log("NEW WEBSOCKET PAIR: start_websocket_get_and_watch_durable_object_index");
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);

        const remove_ws = () => {
            _.remove(this.ws_get_and_watch_durable_object_index, (x) => x === server);
        }

        // Assumption: this tells the runtime this ws socket will be terminated in JS (used as a server).
        // - This must keep a reference to `server` var and keep the web socket running, as it is not garbage collected and closed at the end of this function.
        server.accept();

        server.addEventListener('message', (e) => {
            // const not_string = (typeof e.data !== "string");
            // server.send("ACK string received from wsdo");
        });

        server.addEventListener('error', (event) => {
            log.log("ws.error", event);
            remove_ws();
        });
        server.addEventListener('close', (event) => {
            log.log(`ws.close ${new Date()}`, event);
            remove_ws();
        });


        (async () => {
            const first_msg = await this.get_current_durable_object_index();
            try {
                server.send(JSON.stringify(first_msg));
                // Only send the partial index after the first full index msg.
                this.ws_get_and_watch_durable_object_index.push(server);
            } catch (e) {
                // When: ws closed by client.
            }
        })();


        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

    async get_current_durable_object_index() {
        const all = await this.state.storage.list({prefix: `do-key`});
        const o = [];
        for (const [k, v] of all) {
            o.push(v);
        }

        return {
            kind: "full_index",
            durable_object_list: o
        }

    }
}


interface Env {
}

export {
    DURAFETCH_DO
}