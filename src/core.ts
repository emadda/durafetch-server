import * as _ from "lodash";
import {
    add_ws_helper_fns,
    get_durafetch_do,
    get_internal_req_hostname,
    get_worker_name,
    is_auth_valid,
    starts_with_ext_subdomain, json_res, res_not_authorised
} from "./util";
import {config} from "./config";
import {config_int} from "./config-internal";
import {log} from "./log";


const is_do_binding = (obj) => {
    log.log({obj});

    // Check for interface: DurableObjectNamespace
    return (
        _.isObject(obj) &&
        "idFromName" in obj &&
        typeof obj.idFromName === 'function' &&
        "idFromString" in obj &&
        typeof obj.idFromString === 'function'
    );
}


const get_do_bindings = (env) => {
    const o = [];
    for (const [k, v] of Object.entries(env)) {
        if (is_do_binding(v)) {
            o.push([k, v]);
        }
    }

    return o;
};

const wrap_one_durable_object_stub = (stub, opts) => {
    const {meta} = opts;

    const orig_fn_fetch = stub.fetch;


    let has_set_name_p = null;
    stub.fetch = async (...args) => {

        if (has_set_name_p === null) {
            has_set_name_p = new Promise(async (resolve, reject) => {

                const req = new Request(
                    // Assumption: The domain will stop any external requests from reaching the control machinery of the durable object (as it is not possible to route `https://durafetch.example.com/set-meta` to a worker).
                    // - A common pattern for Workers is to forward external requests via `fetch(external_request)`. This could potentially create an attack vector by allowing external actors to set the name.
                    `https://${get_internal_req_hostname()}/set-meta`,
                    {
                        method: 'POST',
                        headers: {'content-type': 'application/json'},
                        body: JSON.stringify({
                            id: meta.id,
                            name: meta.name
                        })
                    }
                );

                log.log("Making request to set-meta from stub.fetch");
                const res = await orig_fn_fetch.apply(stub, [req]);
                try {
                    const x = await res.json();
                    if (x.ok) {
                        resolve(true);
                        return;
                    }
                } catch (e) {
                    log.error(e);
                }

                // Dev should fix this during development.
                const msg = `Could not set the name of the Durable Object with name ${meta.name} and id ${meta.id}. You need to wrap the durable object to allow it to accept setting the name via fetch.`;
                log.error(msg);
                throw Error(msg);
                // reject(false);

                // Note: wordkerd will not log the Error thrown as it terminates itself first with `Error: The script will never generate a response.`.
                // - Fix: `log.error` works.
            });
        }

        // First `fetch` call sets the name, the next calls will queue until the name has been set.
        await has_set_name_p;


        const res = orig_fn_fetch.apply(stub, args);
        return res;
    };

    return stub;
}


const wrap_one_do_binding = (binding) => {

    // Assumption: Durable objects are always referenced by name.
    // Note: This index has the same lifetime as the JS worker `env` object. Could get very large in the case of accessing millions of durable objects.
    const id_to_meta = {};
    const orig_fn_idFromName = binding.idFromName;
    binding.idFromName = (...args) => {
        const [name] = args;

        const id_obj = orig_fn_idFromName.apply(binding, args);
        const id = id_obj.toString();

        id_to_meta[id] = {
            id,
            name
        };

        return id_obj;
    };


    const orig_fn_get = binding.get;
    binding.get = (...args) => {
        const [id] = args;

        let meta = id_to_meta[id];
        if (!_.isObject(meta)) {
            // When: DO referenced without calling `idFromName` first.
            // E.g. When calling it from DURAFETCH_DO as the client references by `id`.
            meta = {
                id: id.toString(),
                name: null
            }
        }


        const stub = orig_fn_get.apply(binding, args);
        return wrap_one_durable_object_stub(stub, {meta});
    };

    return binding;
}


const wrap_worker_env = (env, opts = {}) => {
    if (config_int.private_key in env) {
        // Already wrapped.
        log.log("Ignoring wrap_env as env already wrapped.");
        return;
    }

    const {
        exclude = []
    } = opts;
    exclude.push("DURAFETCH_DO");

    log.log("wrap_env");

    const do_bindings = get_do_bindings(env);

    log.log("do_bindings.keys", do_bindings.map(x => x[0]));

    for (const [k, v] of do_bindings) {
        if (exclude.includes(k)) {
            continue;
        }

        const proxied_binding = wrap_one_do_binding(v);
        log.log({proxied_binding});
        env[k] = proxied_binding;
    }


    env[config_int.private_key] = {
        env_wrapped: true
    };

    log.log({env});

}


const key_prefix = config_int.private_key_prefix;
const key_next_write_id = `${key_prefix}.next_write_id`;
const get_key_for_write_id = (write_id) => `${key_prefix}.write_id.${write_id}`
const keys_contain_meta = (keys) => keys.some((x) => key_is_meta(x));
const key_is_meta = (k) => k.startsWith(key_prefix);
const get_meta_key = () => `${key_prefix}.meta`

// Usage:
// - Set `this.storage` from the constructor arg[0].
// - Call in durable object class constructor, pass `this`.
const wrap_durable_object = (ins) => {

    const orig_fn_fetch = ins.fetch;
    const orig_fetch = (...args) => {
        return orig_fn_fetch.apply(ins, args);
    }

    // On every operation that writes: Keep a write_id and record the key that was modified
    //
    // - Each write log has a `log_started` - this is like a `log_id` - a specific branch of writes.
    //      - Needed in case of a `deleteAll` then writing to the same keys as before.
    //      - `deleteAll` should delete the write log - it will be recreated on the next DO start.
    //
    // - @todo/low `transaction` not supported. The newer CF runtime implicitly locking the event loop on reads/writes.
    //
    // - Each write to a key gets its own `write_id` - many writes can be part of the same implicit write transaction.
    //      - Transaction ID's are not recorded as they are not observable.
    //      - It is not possible to detect which write is the last one to detect the transaction start/end boundaries as the runtime does this when going from sync to an await point.
    //      - The current write id must be stored in the DO RAM (instead of `await storage.get()`ing it).
    //          - An async read will break the atomic unit of writes - so that writes before or after it are atomic in case of DO process failure.
    const storage = ins.state.storage;


    const wrap_write_fn = (fn_str) => {
        const orig_fn = storage[fn_str];

        // @todo/high Determine the effect of mixing writes without await with await.
        // - Assumption: The order is preserved, but the await just pauses the execution until a write ACK is returned from the disk to the runtime.
        storage[fn_str] = (...args) => {
            let keys = [];
            if (_.isString(args[0]) && ["put", "delete"].includes(fn_str)) {
                keys = [args[0]];
            }
            if (_.isObject(args[0]) && fn_str === "put") {
                keys = _.keys(args[0]);
            }
            if (keys.length === 0 || !init_ran) {
                throw Error("Could not read keys from write fn args, or next_write_id not initialised.");
            }


            if (keys_contain_meta(keys)) {
                // This is a _df write. Do not log.
                return orig_fn.apply(storage, args);
            }


            const write_id = ins[key_prefix].next_write_id.write_id;

            // @todo/high Assumption: Order of writes is preserved; these writes atomically apply together in-order regardless of if the fn caller awaits the returned `write`
            // @see https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/
            // @todo/high Test failure states.
            //  - Can a write tx fail, but the next one complete ok?
            //      - Assumption: A write tx fail is rare and kills the process/invalidates all subsequent writes.
            //          - If not, there could be a gap in write_id's as the local write_id is incremented regardless of transaction success.
            // @todo/maybe Collect write_id's of many writes into a single insert, apply in next write tx with setTimeout(x, 1) to reduce number of writes.
            const write = orig_fn.apply(storage, args);
            storage.put(get_key_for_write_id(write_id), {keys});
            increment_write_id();
            send_event_internal_do_new_cur_write_id_throttled_1s(ins, get_cur_write_id());
            return write;
        }
    };

    const wrap_delete_all = () => {
        const orig_fn = storage.deleteAll;

        // After a deleteAll event, storage is cleared but the class instance variables still reference the write_id-version from the storage state that was cleared.
        // - Reset log_id/write_id. A change in log_id indicates to any reading clients that a new branch has started and to delete all the previous state.
        storage.deleteAll = async (...args) => {
            const ret = await orig_fn.apply(storage, args);
            set_new_write_branch_after_delete_all();
            return ret;
        }
    };


    wrap_write_fn("put");
    wrap_write_fn("delete");
    wrap_delete_all();


    // Ignore deleteAll - it will restart the write log.


    // Read from storage into local DO class instance var.
    let init_ran = false;

    const init_local_once = async (full_meta) => {
        if (init_ran) {
            return;
        }
        init_ran = true;

        // Restore from previous run, or create if it is the very-first instance.
        let next_write_id = await storage.get(key_next_write_id);
        if (next_write_id === undefined) {
            next_write_id = get_new_write_branch();
        }

        if (!(key_prefix in ins)) {
            ins[key_prefix] = {
                next_write_id,
                meta: full_meta
            }
        }
    }

    const set_new_write_branch_after_delete_all = () => {
        ins[key_prefix].next_write_id = get_new_write_branch();
    }

    const get_new_write_branch = () => {
        return {
            // Only unique per DO (to distinguish storage.deleteAll restarts).
            log_id: new Date().toISOString(),
            // Max JS number = 9007199254740991, durable objects are $5/M writes, meaning it would cost $45B to exhaust the ID space. That's 18 Jay-Z's.
            write_id: 1
        }
    }

    const increment_write_id = () => {
        ins[key_prefix].next_write_id.write_id += 1;
        return storage.put(key_next_write_id, ins[key_prefix].next_write_id);
    };
    const get_cur_write_id = () => {
        const x = _.cloneDeep(ins[key_prefix].next_write_id);
        x.write_id -= 1;
        return x;
    }
    const get_cur_write_id_from_storage = async () => {
        const v = await storage.get(key_next_write_id);
        if (v === undefined) {
            return null;
        }
        v.write_id -= 1;
        return v;
    }


    ins.fetch = async (req) => {
        const url = (new URL(req.url));
        const hostname = url.hostname;

        // @todo/med Explicitly define subdomains for internal/external requests.
        if (hostname === get_internal_req_hostname()) {
            if (url.pathname === "/set-meta") {
                const meta = await req.json();
                const full_meta = get_full_meta(meta);

                await init_local_once(full_meta);

                const k = get_meta_key();
                const val = await ins.state.storage.get(k);

                if (val === undefined) {
                    // When: Very first instance of this DO name.
                    log.log("Setting meta", meta);
                    await ins.state.storage.put(k, meta);
                }

                // Notify DURAFETCH_DO that this DO name has started (so that it can update its index).
                await send_event_internal_do_started(ins.env, {
                    obj: get_started_event(full_meta),
                    cur_write_id: await get_cur_write_id_from_storage()
                });


                return json_res({ok: true});
            }
            throw Error(`Incorrect path for wrapped durable object ${url}.`);
        }


        // Forwarded from DURAFETCH_DO.
        // DURAFETCH_DO has already checked: Auth, Request format, Websocket upgrade header.
        if (starts_with_ext_subdomain(ins.env, req)) {

            // Re-check auth in the case of the end user forwarding internet requests to their DO with wildcard domains enabled.
            if (!is_auth_valid(ins.env, req)) {
                return res_not_authorised();
            }


            if (url.pathname === "/external/do/read_all_from") {
                return return_all_data_via_ws_messages(ins, req);
            }

            // @todo/low Add prefix to all error messages from DURAFETCH to allow easier debugging.
            return new Response(`${config_int.primary_name_caps}: Unknown action.`, {status: 400});
        }


        return orig_fetch(req);
    };

    const get_full_meta = (meta) => {
        return {
            worker_name: get_worker_name(),
            class_name: ins.constructor.name,
            name: meta.name,

            id: meta.id,
        }
    }

    const get_started_event = (meta) => {
        return {
            ...get_full_meta(meta),
            last_started_at: new Date()
        }
    }

};


const send_event_internal_do_new_cur_write_id = async (ins, cur_write_id) => {
    const o = await get_durafetch_do(ins.env);

    const req = new Request(
        `https://${get_internal_req_hostname()}/internal/do/new_cur_write_id`,
        {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
                meta: ins[key_prefix].meta,
                cur_write_id
            })
        }
    );
    return o.fetch(req);
};

// Throttle notifications in case of rapid writes.
// Is called with last args, invoked on leading and trailing edge by default.
const send_event_internal_do_new_cur_write_id_throttled_1s = _.throttle(send_event_internal_do_new_cur_write_id, 1000);


const send_event_internal_do_started = async (env, x) => {
    const o = await get_durafetch_do(env);

    const req = new Request(
        // Assumption: The domain will stop any external requests from reaching the control machinery of the durable object (as it is not possible to route `https://durafetch.example.com/set-meta` to a worker).
        // - A common pattern for Workers is to forward external requests via `fetch(external_request)`. This could potentially create an attack vector by allowing external actors to set the name.
        `https://${get_internal_req_hostname()}/internal/do/started`,
        {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(x)
        }
    );
    return o.fetch(req);
}


const return_all_data_via_ws_messages = (durable_object_ins, req) => {
    const url = new URL(req.url);
    const {
        // Read from and including this write_id.
        from_log_id = null,
        from_write_id = null,

        // @todo/med Array of regex filters to match (worker_name, class_name, name, key). Send to DO to filter on read. Also add exclude list?
        filters = null
    } = _.fromPairs([...url.searchParams]);


    log.log("NEW WEBSOCKET PAIR: return_all_data_via_ws_messages");
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    add_ws_helper_fns(server);

    // Assumption: this tells the runtime this ws socket will be terminated in JS (used as a server).
    // - This must keep a reference to `server` var and keep the web socket running, as it is not garbage collected and closed at the end of this function.
    server.accept();

    server.addEventListener('message', (e) => {
        // const not_string = (typeof e.data !== "string");
        // server.send("ACK string received from wsdo");
        log.log("return_all_data_via_ws_messages: ws message received: ", e.data);
    });

    server.addEventListener('error', (event) => {
        log.log("ws.error", event);
    });
    server.addEventListener('close', (event) => {
        log.log(`ws.close ${new Date()}`, event);
    });

    (async () => {
        // No writes have occurred - no data to download.
        // @todo/low When adding to an existing DO there could be data that was written before the write fn's were wrapped.
        const cur_write_id = await durable_object_ins.state.storage.get(key_next_write_id);
        if (cur_write_id === undefined) {
            await read_no_changes(server, "durable_object_has_not_written_any_data");
            return;
        }

        if (_.isString(from_log_id) && _.isString(from_write_id)) {

            // The remote durable object has changed log_id since the client requested (E.g. due to a storage.deleteAll).
            // - Send no changes, and expect the next log_id will be the correct one.
            if (cur_write_id.log_id !== from_log_id) {
                await read_no_changes(server, "requested_log_id_differs_from_remote");
                return;
            }

            const changed_keys = await get_all_keys_changed_from_write_id(durable_object_ins, from_log_id, from_write_id);
            if (_.isArray(changed_keys)) {
                if (changed_keys.length === 0) {
                    await read_no_changes(server, "already_up_to_date");
                    return;
                } else {
                    await read_changes_only(durable_object_ins, server, changed_keys);
                    return;
                }
            }
        }

        // When: First read. Or reading after a `storage.deleteAll`
        await read_all_keys(durable_object_ins, server);
    })();


    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}


const read_changes_only = async (durable_object_ins, server, changed_keys) => {
    const cur_write_id = await durable_object_ins.state.storage.get(key_next_write_id);
    cur_write_id.write_id -= 1;

    server.send_json({
        kind: "start",
        read_type: "changes_only",
        // Data includes writes upto and including this write id.
        cur_write_id
    });

    // @todo/low Allow filtering these keys with a regex.
    // @todo/high Filter values to only those that can be passed to `JSON.stringify`. `put` can store many native JS types.
    const x = _.chunk(changed_keys, 128);
    const keys_exist = [];

    for (const keys of x) {
        // Note: `get([...keys])` - any keys that do not exist are omitted.
        const all = await durable_object_ins.state.storage.get(keys);
        const keys_and_values = {};

        for (const [k, v] of all) {
            keys_and_values[k] = v;
            keys_exist.push(k);
        }

        server.send_json({
            kind: "keys_and_values",
            keys_and_values
        });
    }

    // @todo/next When the deleted keys are the last write, and are deleted from the local, it creates a loop where the local thinks it has to fetch the deletes and then deletes the write_id of those deletes.
    const deletes = _.difference(changed_keys, keys_exist);
    if (deletes.length > 0) {
        server.send_json({
            kind: "deleted_keys",
            deleted_keys: deletes
        });
    }

    server.send_json({
        kind: "end"
    });

    // Wait for client to receive `end`.
    setTimeout(() => {
        server.close();
    }, 60_000);
}

const read_no_changes = async (server, reason = undefined) => {
    server.send_json({
        kind: "start",
        read_type: "no_changes",
        reason
    });
    server.send_json({
        kind: "end"
    });
    setTimeout(() => {
        server.close();
    }, 60_000);
}

const log_all_storage_values = async (ins) => {
    const all = await ins.state.storage.list();

    for (const [k, v] of all.entries()) {
        log.log(JSON.stringify({k, v}, null, 4));
    }
}

const read_all_keys = async (durable_object_ins, server) => {
    let opts = {
        limit: config.number_of_key_values_in_each_do_download_ws_message
    }


    const cur_write_id = await durable_object_ins.state.storage.get(key_next_write_id);
    if (cur_write_id === undefined) {
        throw Error("Only call read_all_keys when cur_write_id is set.");
    }

    // await log_all_storage_values(durable_object_ins);
    cur_write_id.write_id -= 1;


    server.send_json({
        kind: "start",
        read_type: "from_start",
        // Data includes writes upto and including this write id.
        // Note: Client can get this event even when they have a previous download - `deleteAll` could start a new branch.
        cur_write_id
    });

    while (true) {
        const all = await durable_object_ins.state.storage.list(opts);
        const keys_and_values = {};
        let last_k = null;


        for (const [k, v] of all) {
            // @todo/low Allow filtering these keys with a regex.

            // Exclude `_df` keys.
            if (key_is_meta(k)) {
                continue;
            }

            keys_and_values[k] = v;
            last_k = k;
        }

        if (last_k === null) {
            break;
        }

        // Assumption: All of these reads happen inside one read tx, and block writes/other events.
        // - Await points close tx's implicitly, reads block incoming events from interrupting this loop.
        // - @see https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/
        server.send_json({
            kind: "keys_and_values",
            keys_and_values
        });

        opts.startAfter = last_k;
    }

    server.send_json({
        kind: "end"
    });

    // Wait for client to receive `end`.
    setTimeout(() => {
        server.close();
    }, 60_000);
}


const get_all_keys_changed_from_write_id = async (durable_object_ins, from_log_id, from_write_id) => {
    const cur_write_id = await durable_object_ins.state.storage.get(key_next_write_id);
    cur_write_id.write_id -= 1;

    if (from_log_id !== cur_write_id.log_id) {
        // Incremental update not possible (likely because deleteAll has restarted the write log).
        return null;
    }

    const client_cur_write_id = from_write_id - 1;

    if (client_cur_write_id === cur_write_id.write_id) {
        // No changes.
        return [];
    }

    if (client_cur_write_id > cur_write_id.write_id) {
        // Client cannot be ahead of master.
        throw Error(`Requesting to read from a write id (${from_write_id}) that is passed the current write id (${cur_write_id.write_id})`);
    }

    const write_ids_to_read = _.range(from_write_id, cur_write_id.write_id + 1);
    const keys = []
    for (const x of write_ids_to_read) {
        // Ignore client asking from ID's from 0.
        if (x === 0) {
            continue;
        }

        const v = await durable_object_ins.state.storage.get(get_key_for_write_id(x));
        if (v === undefined) {
            throw Error(`Missing write_id in write log for Durable Object. log_id=${from_log_id} write_id=${x}. This could be caused by a failed tx followed by a successful tx.`);
        }

        if (keys_contain_meta(v.keys)) {
            throw Error(`Meta data included in changed key listing - it should not be. key_prefix=${key_prefix}.`);
        }

        keys.push(...v.keys);
    }
    return _.uniq(keys);
}


export {
    wrap_worker_env,
    wrap_durable_object
}