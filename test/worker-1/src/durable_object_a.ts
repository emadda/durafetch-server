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


        // - Intercepts calls to `fetch`
        // - 1. Internal (from worker): `/set-meta` will set the id/name of this Durable Object, and then send a "durable object started" event to DURAFETCH_DO.
        // - 2. External (from the internet): `/external/do/read_all_from` will return storage data from a given write_id via a WebSocket.

        // Intercepts calls to `storage.*`
        // - Records the keys written to and stores them in the same write transaction, increments write_id.
        wrap_durable_object(this, {class_name: DURABLE_OBJECT_A.name});
    }

    // Your application code here.
    async fetch(request: Request) {
        const storage = this.state.storage;
        const now = (new Date()).toISOString();


        const v = (await storage.get("request_counter")) ?? {worker_name: p.name, counter: 0, now: null};

        v.counter++;
        v.now = now;

        // The key `request_counter` is recorded as a change behind the scenes by Durafetch.
        await storage.put("request_counter", v);


        return new Response(
            JSON.stringify(v, null, 4),
            {headers: {'content-type': 'application/json'}}
        );
    }
}

interface Env {
}

export {
    DURABLE_OBJECT_A
};