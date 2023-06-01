import p from './../package.json';
import {config} from "durafetch-server";

console.log("CONFIG SET");
config.set_config({
    worker_name: p.name
});

export * from "durafetch-server";