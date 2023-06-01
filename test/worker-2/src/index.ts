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
        wrap_worker_env(env);

        if (starts_with_ext_subdomain(env, request)) {
            const o = await get_durafetch_do(env);
            return o.fetch(request);
        }

        // Ignore when loading from a browser.
        const favicon = ignore_favicon(request, env);
        if (favicon) {
            return favicon;
        }


        const url = new URL(request.url);

        if (request.method === "POST" && url.pathname === "/set-step-many") {
            const {names, step} = await request.json();

            const all = [];
            for (const n of names) {
                const id_do = env.DURABLE_OBJECT_A.idFromName(n);
                const stub = env.DURABLE_OBJECT_A.get(id_do);
                all.push(stub.fetch(new Request(
                    "https://example.com/set-step",
                    {
                        method: 'POST',
                        headers: {'content-type': 'application/json'},
                        body: JSON.stringify({name: n, step})
                    }
                )));
            }

            const x = await Promise.all(all);
            for (const res of x) {
                console.log(await res.json());
            }

            return new Response(
                JSON.stringify({ok: true}),
                {headers: {'content-type': 'application/json'}}
            );
        }


        return new Response("Unknown action");
    },
};


export {
    DURABLE_OBJECT_A,
    DURAFETCH_DO
}
