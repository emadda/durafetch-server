import {config} from "./config";

// Disable logging when added to end users project.
// - Keep errors to enable debugging any issues.

const levels = [
    "error", "warn", "log", "info", "debug"
];

const is_enabled = (level) => {
    // Note: `config.log_level` may change at runtime.
    const all_enabled = levels.slice(0, levels.indexOf(config.log_level) + 1);
    return all_enabled.includes(level);
}

const log = {
    error: (...args) => {
        if (is_enabled("error")) {
            console.error(...args);
        }
    },

    log: (...args) => {
        if (is_enabled("log")) {
            console.log(...args);
        }
    }
}


export {
    log
}