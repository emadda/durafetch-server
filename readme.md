# Durafetch

Durafetch allows you to download your Cloudflare Durable Object state into a local SQLite database file.

It consists of two npm packages:

- 1 . `durafetch-server`
	- This repo - JS code that you `import` into your Cloudflare Worker.
	- Wraps functions such as `fetch` to keep a list of Durable Object IDs.
	- Works on localhost for usage during development.

- 2 . `durafetch`
	- Repo: [durafetch](https://github.com/emadda/durafetch)

	- A CLI client that:
		- Downloads the list of Durable Object IDs.
		- Determines which objects have new data since the last run.
		- Connects to each Durable Object directly via WebSocket and downloads only the changes since last download.
		- Writes them to a local SQLite database.

	- Usage:
		- `npm install durafetch`
		- `durafetch --config-file ./local/config.json`

# Why use Durafetch?

## A. As an admin UI

Durable Objects do not have an admin UI or any other method of observing their state
other than the provided JS API's.

This makes development difficult as you cannot see what is stored in your Durable Object.

Durafetch gives you a SQL interface to see what the state of your system is so you can observe it during development and in production.

## B. For queries.

Durable Objects are distributed by their nature, but it is often useful to create a central database of the state so you can query it as a single datastore. SQLite gives you a SQL query engine with JSON functions.

## C. For backup and restoring.

There is no method to extract data from Durable Objects - Durafetch lets you do this.

Presently there is no method for restoring - this may be added later.

# Steps to add Durafetch to your Cloudflare worker.

- [test/worker-1](test/worker-1) Minimal example worker you can test locally.

## Steps

- 1 . `npm install durafetch-server`
- 2 . Create a [durafetch-with-config.ts](test/worker-1/src/durafetch-with-config.ts) file.
	- This will pass the worker_name to durafetch.
	- Import functions from here.
- 3 . Add `DURAFETCH_DO` to [wrangler.toml](test/worker-1/wrangler.toml), along with subdomain routes, `DURAFETCH_AUTH` env.
- 4 . Add [`wrap_worker_env()`](test/worker-1/src/index.ts) to worker fetch, along with external Durafetch API handler.
- 5 . Add [`wrap_durable_object(this)`](test/worker-1/src/durable_object_a.ts) to any Durable Objects you want to download the data from.

### Setting up subdomain routing.

Each worker has its own Durafetch external API (CF service bindings are not used). The Durafetch CLI fetches data from each of them and writes them all to the same SQLite DB.

The Durafetch external API is reachable from a subdomain: `durafetch_{your_worker_name}.your-domain.com`. CF has automatic HTTPS cert provisioning for first level subdomains - the wildcard subdomain allows you to route any subdomain to your worker.

Add this to your wrangler.toml:

```
routes = [
    { pattern = "*.your-domain.com/*", zone_name = "your-domain.com" }
]
```

Add `your-domain.com` to Cloudflare DNS.

Add a CNAME record:

| Type  | Name | Content                     | Proxy Status |
|-------|------|-----------------------------|--------------|
| CNAME | *    | can.be.anything.example.com | Proxied      |

Because this is "Proxied", the `Content` target is ignored and CF DNS returns the IP of your worker.

## Using the CLI client to download data to a SQLite db

- 1 . `npm install durafetch`
- 2 . Save JSON config that looks like this (`worker-1` is the name of your worker):

```
{
    "db_file": "./del/db.sqlite",
    "servers": [
        {
            "ws_url": "ws://durafetch_worker-1.localhost:8720",
            "auth_token": "secret_http_auth_bearer_token_replace_this_with_more_than_40_chars"
        }
    ]
}
```

- 3 . Start client: `durafetch --config-file ./config.json`

# Pricing

- [License](LICENSE)
- [https://durafetch.com#pricing](https://durafetch.com#pricing)

# Scalability

Durafetch has been designed with scalability in mind:

- You should be able to extract more than 128MB of data (a single worker has 128MB of RAM) as WebSockets are used to stream the key/values instead of storing them in RAM.
- WebSockets connect directly to each Durable Object (they do not go via a proxy Durable Object which would become a bottleneck).
- Only changes are downloaded - DF will not re-read previous key/value data it already has downloaded.
	- Minimizes requests, CPU time and costs.
- Minimal data copies.
	- The values of `storage.put("key", "value")` are not copied on every change - when the CLI client downloads data it reads the current state directly from the Durable Object.
		- Values do not get sent to intermediate storage (like R2 or another Durable Object) on change - this reduces request/storage costs.
	- Changes to keys are recorded for each write - this allows the "download only changes" logic to work.
		- The assumption is that keys are generally much smaller than values.
	- When using Durafetch the number of write requests are doubled - each write triggers a second write that records the key(s) that were written to along with a integer write_id.
		- The cost of write requests is currently [$1 per million](https://developers.cloudflare.com/workers/platform/pricing/#durable-objects).

Please create an issue if you encounter any problems.

# Security

- In production only HTTPS/WSS is allowed.
- Requests for the external Durafetch API must use a `Authorization: Bearer` HTTP header with the secret token set as an env var.

# To do

- Client
	- [ ] Detect writes to the SQLite database, write them back to the remote object.
	- [ ] Optionally keep a SQLite write audit history to make deletes visible and allow syncing to other systems.
	- [ ] Export/restore CLI.

- Server
	- [ ] Compress/Garbage collect the "changed keys" history stored in each Durable Object.
	- [ ] Regex filter to include/exclude by class/name/key.

