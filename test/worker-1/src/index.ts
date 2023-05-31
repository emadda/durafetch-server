import {DURABLE_OBJECT_A} from "./durable_object_a";
import * as durafetch from "./durafetch-with-config";

const {
    core: {
        wrap_worker_env
    },
    util: {
        get_durafetch_do,
        get_external_subdomain,
        starts_with_ext_subdomain
    },
    durafetch_do: {
        DURAFETCH_DO
    }
} = durafetch;


export interface Env {
    DURABLE_OBJECT_A: DurableObjectNamespace;
    DURAFETCH_DO: DurableObjectNamespace;
}


const ignore_favicon = (request, env) => {
    if (new URL(request.url).pathname.startsWith("/favicon.ico")) {
        return new Response(null, {status: 204});
    }
    return null;
}

export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext
    ): Promise<Response> {

        // - Intercepts calls to durable object bindings.
        // - When sending a request to a durable object's `fetch`, the `id` and `name` are intercepted and sent to the same durable object.
        // - Inside the durable objects `fetch` this will then set `id` and `name`, and also send a "durable object started" event to DURAFETCH_DO.
        // - DURAFETCH_DO keeps a list of all durable objects that have ever been started within this worker.
        wrap_worker_env(env);


        // - This is the external HTTP API for DURAFETCH_DO.
        //      - 1. Lists all past and current Durable Object IDs.
        //      - 2. Forwards read requests to specific Durable Object ID instances which return data via WebSocket.
        //
        // - Subdomain config:
        //      - wrangler.toml: Add `{ pattern = "*.example.com/*", zone_name = "example.com" }` to `routes`
        //          - HTTPS provisioning for first level subdomains is automatic/free for all CF accounts.
        //          - May need to add `durafetch_worker-1.localhost` to `/etc/hosts` for dev requests to work locally.
        //      - CF DNS: Add "CNAME * can.be.anything.as.worker.route.overrides.example.com"
        //          - For "Proxied" entries the workers routes takes precedence so the CNAME target never takes effect.
        //      - You can observe this traffic by using the "reverse proxy" feature of many proxy tools.
        if (starts_with_ext_subdomain(env, request)) {
            const o = await get_durafetch_do(env);
            return o.fetch(request);
        }


        // Add your applications URL handlers here.


        // Ignore when loading from a browser.
        const favicon = ignore_favicon(request, env);
        if (favicon) {
            return favicon;
        }


        // An example of messaging a durable object.
        const id_do = env.DURABLE_OBJECT_A.idFromName("example-name");
        const stub = env.DURABLE_OBJECT_A.get(id_do);

        return stub.fetch(request);
        // return new Response("Hello World!");
    },
};


export {
    DURABLE_OBJECT_A,
    DURAFETCH_DO
}
