import p from './../package.json';
import * as durafetch from "./durafetch-with-config";


const {
    core: {
        wrap_durable_object
    }
} = durafetch;


// An example of one of your own application Durable Objects.
class DURABLE_OBJECT_A {
    state: DurableObjectState

    constructor(state: DurableObjectState, env: Env) {
        this.state = state;
        this.env = env;
        wrap_durable_object(this, {class_name: DURABLE_OBJECT_A.name});
    }


    async fetch(request: Request) {
        const storage = this.state.storage;
        const now = (new Date()).toISOString();

        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/set-step") {
            const {name, step} = await request.json()

            switch (step) {
                case "step-1":
                    // No writes, but Durable Object will report to DURAFETCH_DO that it has been created and exists.
                    break;
                case "step-2":
                    // CREATE

                    // Single
                    storage.put("key-a", 1);

                    // Multi
                    storage.put({
                        "key-b": 1,
                        "key-c": 1,
                        "key-d": 1
                    });

                    break;

                case "step-3":
                    // UPDATE

                    // Single
                    storage.put("key-a", 2);

                    // Multi
                    storage.put({
                        "key-b": 2,
                        "key-c": 2,
                        "key-d": 2,
                    });
                    break;
                case "step-4":
                    // DELETE

                    // Single
                    storage.delete("key-a");

                    // Multi
                    storage.delete(["key-b", "key-c"]);

                    break;
                case "step-5":
                    // DELETE ALL
                    storage.deleteAll();
                    break;

                default:
                    throw Error(`Unknown step ${step}`);
                    // return new Response("Unknown action", {status: 400});
                    break;
            }


            return new Response(
                JSON.stringify({ok: true}, null, 4),
                {headers: {'content-type': 'application/json'}}
            );
        }

        return new Response("Unknown action", {status: 400});
    }
}

interface Env {
}

export {
    DURABLE_OBJECT_A
};