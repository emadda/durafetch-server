// @see https://stackoverflow.com/questions/49320632/how-to-import-an-npm-module-that-has-a-typescript-main-file-in-typescript

import * as config from "./src/config"
import * as core from "./src/core"
import * as durafetch_do from "./src/durafetch-do"
import * as util from "./src/util"


export {
    config,
    core,
    durafetch_do,
    util
}