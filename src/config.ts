import _ from "lodash";

// @see https://developers.cloudflare.com/workers/platform/limits/#durable-objects-limits
const max_val_size_kb = 128;
const ram_per_do_kb = 128 * 1000;

const default_config = {
    // Use upto 64MB RAM.
    number_of_key_values_in_each_do_download_ws_message: (ram_per_do_kb / 2) / max_val_size_kb,
    worker_name: null,
    log_level: "error",

    // When writes occur in a DO they send an HTTP request to DURAFETCH_DO to notify it of a new write_id.
    // - Rate limit those notifications to one notification per x ms.
    max_write_notifications_per_do_in_ms: 100
}

const config = {
    ...default_config
};

// Allow setting `worker_name` from the importing parent package.
// - `worker_name` may come from many places (package.json name, CF env vars etc).
// - There does not seem to be a documented CF interface to read this from the worker.
// - The importer should create a `durafetch-configured.ts` file with `set_config(x); export * from "durafetch-server"`.
//      - Imported files are only run once even if included multiple times.
const set_config = (x) => {
    _.merge(config, x);
}


export {
    set_config,
    config
}