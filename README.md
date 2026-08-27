# @cldmv/slothlet-vine

Vines between slothlet api trees.

[![npm version]][npm_version_url] [![npm downloads]][npm_downloads_url] [![GitHub downloads]][github_downloads_url] [![Last commit]][last_commit_url] [![npm last update]][npm_last_update_url]

[![npm unpacked size]][npm_size_url] [![Repo size]][repo_size_url] [![Contributors]][contributors_url] [![Sponsor shinrai]][sponsor_url]

---

[Slothlet](https://github.com/CLDMV/slothlet) composes a folder of modules into an api **tree**. A **vine** connects two trees across an execution boundary — a Web Worker, another thread, another process, or another machine — by mounting **forwarding leaves**: stubs that live at the callee's identical logical path in the caller's tree, so `self.exts.foo.bar()` works the same whether `foo` is co-located or isolated. Slothlet cannot tell a vine leaf from a real one — including its permission identity, so a rule targeting `exts.foo.bar` gates the forwarding stub exactly as it would gate the real leaf, before it dispatches.

That gating follows slothlet's own rule about **who is calling**: a call made by a MODULE (`self.exts.foo.bar()`) is checked against the permission rules, and a denied one never runs the stub body, so it never reaches the wire. A call made through the bound handle `slothlet()` returned — the host itself — carries host standing and is not checked. That carve-out is slothlet's design, not a vine gap, but it does mean "permission-gated" describes module-initiated calls; a host that forwards on someone else's behalf is responsible for its own authorization.

---

## ✨ What's New

### Latest: v1.0.0 (August 2026)

- **First real release (#2)** — the pre-implementation scaffold published as `0.1.0` is superseded entirely. `grow()`/`serve()`, the frame protocol, the error taxonomy, and a reusable Channel conformance harness are all in place, and **all five built-in transports are implemented and tested end-to-end over their real boundaries** — `loopback`, `post-message`, `worker-threads`, `process`, and `websocket`.
- **Data-only enforcement, both directions** — a function anywhere in a call's arguments or return value is refused at the edge (`VINE_DATA_ONLY`), checked grow-side before a frame is ever sent and independently re-checked serve-side, so a frame built directly against a by-reference channel can't slip a live closure across the boundary either.
- [View full v1.0.0 Changelog](https://github.com/CLDMV/slothlet-vine/blob/master/docs/changelog/v1/v1.0.0.md)

📚 **For complete version history and detailed release notes, see the [docs/changelog/](https://github.com/CLDMV/slothlet-vine/tree/master/docs/changelog/) folder.**

---

## 🚀 Key Features

### 🎯 **Location-Transparent Forwarding**

`grow()` mounts one stub per far-side leaf at the **identical dotted path** slothlet would use locally — `self.exts.pdfViewer.open()` reads the same whether `pdfViewer` runs in-process, in a worker, or in another machine entirely.

### 🔐 **Permission-Gated by Slothlet Itself**

A mounted stub is a real slothlet leaf as far as slothlet's own permission system is concerned. There is no separate vine-side authorization layer to configure, audit, or drift out of sync with the rest of the api tree.

### 📦 **Data-Only by Design**

A function argument or return value is refused at the edge with a named, catchable error — never a silent clone-crash, and never a live closure smuggled across an isolation boundary.

### 🔌 **Five Built-In Transports, Pluggable Contract**

`loopback`, `post-message`, `worker-threads`, `process`, and `websocket` ship as independent subpath exports (only what you import is pulled in). Anything that can implement the small `Channel` interface — `send`, `onMessage`, `close`, an optional `onClose`, and a `capabilities` declaration — can host a vine.

### ⏱ **Settle-Once Correlation & Budgets**

Every call is correlated by `callId` and bounded by a per-call budget. A pending call always settles — success, error, or timeout — even against a far side that never answers.

### 🧪 **Reusable Conformance Harness**

`@cldmv/slothlet-vine/testing` exports the same framework-injected test suite the five built-in transports are held to, so a custom transport can be verified against the identical contract.

### 🛡 **100% Test Coverage**

Statements, branches, functions, and lines — held to the same bar as slothlet itself.

---

## 📦 Installation

### Requirements

- A slothlet instance to grow from or serve — `@cldmv/slothlet` `>=3.14.0` (peer dependency)
- ESM (`import`); CommonJS interop follows whatever your bundler/runtime provides for a `"type": "module"` package
- The `websocket` transport additionally needs the optional peer `ws` `>=8.0.0` — only if you import it

### Install

```bash
npm install @cldmv/slothlet-vine
```

---

## 🚀 Quick Start

```javascript
import * as vine from "@cldmv/slothlet-vine";
import { createPair } from "@cldmv/slothlet-vine/transport/loopback";

const [near, far] = createPair();

// serve this instance's leaves to the far side
const serving = await vine.serve(workerApi, far, { paths: ["exts"] });

// mount the far tree's leaves into this instance, at identical paths
const link = await vine.grow(hostApi, near, { budgetMs: 5000 });
await hostApi.exts.pdfViewer.open("a.pdf"); // executes on the serving instance

await link.close(); // stubs unmounted; in-flight calls settle VINE_CLOSED
serving.close();
```

Swap `transport/loopback` for any of the other four built-in transports, or your own `Channel` implementation, without changing anything above `createPair()`/`connect()`. Single-word leaves, context carried by the namespace — never `growVine()`-style camelCase that repeats the package's own name.

---

## 📚 Configuration

`grow()` and `serve()` both take `(api, channel, options)` — the local slothlet instance, the transport seam, and an options object. The complete reference — every option, every return field — lives in **[docs/CONFIGURATION.md](https://github.com/CLDMV/slothlet-vine/blob/master/docs/CONFIGURATION.md)**.

| Function  | Option        | Type       | Default              | Description                                                               |
| --------- | ------------- | ---------- | -------------------- | ------------------------------------------------------------------------- |
| `serve()` | `paths`       | `string[]` | every callable leaf  | Dotted prefixes to publish                                                |
| `serve()` | `modules`     | `string[]` | —                    | Extra moduleIDs to union in (runtime `add()` mounts `leaves()` can't see) |
| `grow()`  | `budgetMs`    | `number`   | `30000`              | Per-call settle budget; exceeded → `VINE_BUDGET`                          |
| `grow()`  | `handshakeMs` | `number`   | `budgetMs`           | Deadline for the initial surface (leaf-manifest) frame                    |
| `grow()`  | `paths`       | `string[]` | every published leaf | Dotted prefixes to mount (grow-side mirror of `serve()`'s own filter)     |

`serving.close()`/`link.close()` never close the channel itself — a channel may outlive one `grow`/`serve` pairing, and one a consumer handed in is not this call's to tear down.

---

## 📚 Documentation

`docs/` isn't included in the published npm package (only `src`, `schemas`, `README.md`, and `LICENSE` ship — see [DESIGN.md](https://github.com/CLDMV/slothlet-vine/blob/master/docs/DESIGN.md)), so every link below is absolute and works the same from npmjs.com, an editor previewing the installed package, or GitHub itself.

### Reference

- **[Design & Protocol](https://github.com/CLDMV/slothlet-vine/blob/master/docs/DESIGN.md)** — the normative Channel contract, frame schema, `grow`/`serve` semantics, and error taxonomy. If a guide below and this disagree, this wins.
- **[Configuration Reference](https://github.com/CLDMV/slothlet-vine/blob/master/docs/CONFIGURATION.md)** — every `grow()`/`serve()` option, with defaults, and what `link`/`serving` return.
- **[Changelog](https://github.com/CLDMV/slothlet-vine/tree/master/docs/changelog/)** — all release notes.

### Technical Guides

- **[Transports](https://github.com/CLDMV/slothlet-vine/blob/master/docs/TRANSPORTS.md)** — the five built-in transports, when to reach for each, and the death-detection/ownership details that differ between them.
- **[Writing a Custom Transport](https://github.com/CLDMV/slothlet-vine/blob/master/docs/CUSTOM-TRANSPORTS.md)** — implementing the Channel contract, the uniform send-failure policy, and verifying it with the shared conformance harness.
- **[Error Reference](https://github.com/CLDMV/slothlet-vine/blob/master/docs/ERRORS.md)** — the `VINE_*` code list, `VineError`/`VineRemoteError`, and why a remote `VINE_*` code is never adopted as-is.
- **[Permissions](https://github.com/CLDMV/slothlet-vine/blob/master/docs/PERMISSIONS.md)** — how slothlet's own permission system gates a mounted stub exactly like a real leaf.
- **[Using a Vine in the Browser](https://github.com/CLDMV/slothlet-vine/blob/master/docs/BROWSER.md)** — a full Web Worker walkthrough with the `post-message` transport.

---

## 🔗 Links

- **npm**: [@cldmv/slothlet-vine](https://www.npmjs.com/package/@cldmv/slothlet-vine)
- **GitHub**: [CLDMV/slothlet-vine](https://github.com/CLDMV/slothlet-vine)
- **Issues**: [GitHub Issues](https://github.com/CLDMV/slothlet-vine/issues)
- **Releases**: [GitHub Releases](https://github.com/CLDMV/slothlet-vine/releases)

---

## 📄 License

[![GitHub license]][github_license_url] [![npm license]][npm_license_url]

Apache-2.0 © Shinrai / CLDMV

[npm version]: https://img.shields.io/npm/v/%40cldmv%2Fslothlet-vine.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_version_url]: https://www.npmjs.com/package/@cldmv/slothlet-vine
[npm downloads]: https://img.shields.io/npm/dm/%40cldmv%2Fslothlet-vine.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_downloads_url]: https://www.npmjs.com/package/@cldmv/slothlet-vine
[github downloads]: https://img.shields.io/github/downloads/CLDMV/slothlet-vine/total?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[github_downloads_url]: https://github.com/CLDMV/slothlet-vine/releases
[last commit]: https://img.shields.io/github/last-commit/CLDMV/slothlet-vine?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[last_commit_url]: https://github.com/CLDMV/slothlet-vine/commits
[npm last update]: https://img.shields.io/npm/last-update/%40cldmv%2Fslothlet-vine?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_last_update_url]: https://www.npmjs.com/package/@cldmv/slothlet-vine
[npm unpacked size]: https://img.shields.io/npm/unpacked-size/%40cldmv%2Fslothlet-vine.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_size_url]: https://www.npmjs.com/package/@cldmv/slothlet-vine
[repo size]: https://img.shields.io/github/repo-size/CLDMV/slothlet-vine?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[repo_size_url]: https://github.com/CLDMV/slothlet-vine
[github license]: https://img.shields.io/github/license/CLDMV/slothlet-vine.svg?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[github_license_url]: https://github.com/CLDMV/slothlet-vine/blob/HEAD/LICENSE
[npm license]: https://img.shields.io/npm/l/%40cldmv%2Fslothlet-vine.svg?style=for-the-badge&logo=npm&logoColor=white&labelColor=CB3837
[npm_license_url]: https://www.npmjs.com/package/@cldmv/slothlet-vine
[contributors]: https://img.shields.io/github/contributors/CLDMV/slothlet-vine.svg?style=for-the-badge&logo=github&logoColor=white&labelColor=181717
[contributors_url]: https://github.com/CLDMV/slothlet-vine/graphs/contributors
[sponsor shinrai]: https://img.shields.io/github/sponsors/shinrai?style=for-the-badge&logo=githubsponsors&logoColor=white&labelColor=EA4AAA&label=Sponsor
[sponsor_url]: https://github.com/sponsors/shinrai
