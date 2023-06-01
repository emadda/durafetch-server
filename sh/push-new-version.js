#!/usr/bin/env node

// Script to push a new version.
// - Ensures local git tags, remote Github repo and NPM are all in sync.
// - Copies tag from package.json to git tag, pushes to remote.
// - Pushes version to npm.

const fs = require("fs");
const util = require('util');
const exec = util.promisify(require('child_process').exec);

const github_repo = `https://github.com/emadda/durafetch-server`;


const run = async () => {
    let x;

    x = await exec('git status --short package.json');
    if (/^M/.test(x.stdout.trim())) {
        console.error("Error: Must commit package.json as `npm publish` will read the version from the remote Github repo.");
        return false;
    }

    const package_buffer = fs.readFileSync("package.json");
    const p = JSON.parse(package_buffer.toString());
    const cur_version = p.version;
    const new_tag = `v${cur_version}`;


    // Check the tag is new.
    x = await exec('git tag');
    const tags = x.stdout.split("\n").filter(x => /^v\d/.test(x));

    if (tags.includes(new_tag)) {
        console.error(`Error: Version ${cur_version} already exists as a git tag.`);
        return false;
    }


    // Create git tag, push to remote.
    console.log(`Creating local git tag ${new_tag} and pushing to remote origin.`);
    x = await exec(`git tag ${new_tag}`);
    x = await exec(`git push -u origin master`);
    x = await exec(`git push origin ${new_tag}`);
    console.log(x.stdout);


    // Publish to NPM.
    // x = await exec(`npm publish ${github_repo}`);
    // console.log(x.stdout);
    // console.log("Published to NPM");

    // Use the remote Github repo to ensure the code is committed and pushed.
    // Run this manually to enter the OTP:
    console.log(`Now run "npm publish ${github_repo}"`);
    // npm publish https://github.com/emadda/durafetch-server

    return true;
}


run();