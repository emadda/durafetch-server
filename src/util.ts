import _ from "lodash";
import {config} from "./config";
import {config_int} from "./config-internal";
import {log} from "./log";


// esbuild can use a text loader for toml, which can be parsed.
// Assumption: package.json "name" matches the name in the wrangler.toml (it is the worker name).
// @todo/low Service bindings may confuse this, as it skips the worker associated with the DO.
const get_worker_name = () => {
    const valid = (_.isString(config.worker_name) && config.worker_name.length > 0);
    if (!valid) {
        const msg = `Must set worker_name in ${config_int.primary_name} config`;
        log.error(msg);
        throw Error(msg);
    }

    return config.worker_name;
};


const get_external_subdomain = () => {
    return `${config_int.primary_name}_${get_worker_name()}`
}


// Determines if an external request should be routed to the Durafetch external HTTP API.
//
// Issue: `ws://x.example.com` allows plaintext WebSocket messages, even when the CF site is configured to only allow HTTPS.
// Fix: Detect when running on CF, reject plaintext HTTP websocket upgrades.
//
// There is no way to detect when running on CF vs a local workerd instance in dev, so an env var is used.
// @see https://developers.cloudflare.com/workers/examples/block-on-tls/
// - `request.cf` with tls is still set in local workerd with http.
const starts_with_ext_subdomain = (env, request) => {
    const url = new URL(request.url);
    const is_for_ext_subdomain = url.hostname.startsWith(get_external_subdomain());

    if (!is_for_ext_subdomain) {
        return false;
    }

    // Assert env is configured to ensure `prod` (running on CF) can be identified.
    const msg = `${config_int.env_key_env} should be set to either "dev" or "prod" in wrangler.toml. In dev overrride in the ".dev.vars" file.`

    // DURAFETCH_ENV
    if (!(config_int.env_key_env in env)) {
        console.error(msg);
        return false;
    }

    const df_env = env[config_int.env_key_env];
    if (!["dev", "prod"].includes(df_env)) {
        console.error(msg);
        return false;
    }

    if (df_env === "prod" && url.protocol !== "https:") {
        console.error(`Ignoring plaintext HTTP request for the external Durafetch API - must use wss:// or https://.`, {url});
        return false;
    }

    return true;
}

const get_durafetch_do = async (env) => {
    const id_do = env.DURAFETCH_DO.idFromName("primary");
    return env.DURAFETCH_DO.get(id_do);
}

// This is used in two places:
// 1. Workers/DO to DURAFETCH_DO
// 2. Worker to user DO that is wrapped.
const get_internal_req_hostname = () => {
    return `${config_int.primary_name}.example.com`
}


const env_key_auth = config_int.env_key_auth;

// @todo/low Allow configuring allowable IP's.
// @todo/low Rate limit password attempts (CF WAF already does this by default. A long secret key makes brute forcing unlikely).
const is_auth_valid = (env, req) => {
    const ok = (
        env_key_auth in env &&
        _.isString(env[env_key_auth]) &&
        env[env_key_auth].length >= 40
    );

    if (!ok) {
        const msg = `Set ${env_key_auth} env var to a single admin secret token with a length >= 40. It is unique to your CF worker.`;
        log.error(msg);
        throw Error(msg);
    }

    const allowed_tokens = [env[env_key_auth]];

    const x = req.headers.get("Authorization");

    if (x === null) {
        return false;
    }

    const token = x.replace(/^Bearer /i, "");
    return allowed_tokens.includes(token);
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

const res_not_authorised = () => {
    return json_res({
        ok: false,
        msg: "Auth invalid. Include `Authorization: Bearer x` token and set the auth token as an env var."
    }, {status: 401});
}


const add_ws_helper_fns = (server) => {
    server.send_json = (x) => {
        return server.send(JSON.stringify(x));
    };
}

export {
    get_worker_name,
    get_external_subdomain,
    starts_with_ext_subdomain,
    get_durafetch_do,
    get_internal_req_hostname,
    is_auth_valid,
    json_res,
    res_not_authorised,
    add_ws_helper_fns

}