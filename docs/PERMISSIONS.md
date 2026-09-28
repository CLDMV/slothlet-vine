# Permissions

The vine doesn't have its own permission system — it doesn't need one. A grown stub is mounted into the local slothlet instance at the callee's identical dotted path, using the same `api.slothlet.api.add()` a real module would use to add a leaf at runtime. Slothlet cannot tell a forwarding stub from a real leaf, **including its permission identity**, so a rule targeting `exts.foo.bar` gates the stub exactly as it would gate the real thing — before the stub body runs, before anything crosses the wire.

This page is about that interaction specifically. For the permission system itself — rule syntax, glob patterns, the `condition` field — see slothlet's own [`docs/PERMISSIONS.md`](https://github.com/CLDMV/slothlet/blob/master/docs/PERMISSIONS.md) and [`docs/PERMISSIONS-CONDITIONS.md`](https://github.com/CLDMV/slothlet/blob/master/docs/PERMISSIONS-CONDITIONS.md).

---

## Who is checked, and who isn't

Slothlet's permission rules gate calls made by a **module** — `self.exts.foo.bar()` from inside some other module's code. A call made through the bound handle `slothlet()` itself returned — the host — carries host standing and is **not checked**. That carve-out is slothlet's own design, not a vine gap, but it means "permission-gated" specifically describes module-initiated calls. A host that forwards a caller's request on someone else's behalf is responsible for its own authorization before it does; the vine doesn't add one on top.

**On a trusted transport, the far side is a cooperative peer.** A worker you spawned or a process you forked is trusted to gate its own module-initiated calls at the stub and to report its subscribers' identities honestly; the serving side does not re-check either, and a `call` frame it receives runs with host standing. That is the default, and it stays the right one for those transports. For a peer the host cannot trust — a browser page holding a socket — the serving side binds a **channel principal** instead; see the next section.

```javascript
const growApi = await slothlet({
	base: "./api",
	permissions: {
		defaultPolicy: "allow",
		rules: [{ caller: "caller.**", target: "exts.secret", effect: "deny" }]
	}
});
const link = await grow(growApi, channel, { budgetMs: 5000 });

// A MODULE call is gated:
await growApi.caller.doSecretThing(); // throws PERMISSION_DENIED — never reaches the stub body

// The HOST'S OWN call is not:
await growApi.exts.secret(); // runs — this is the host, not a module
```

---

## Serving to an untrusted peer: the channel principal

The grow-side gate above stops a far **module** from calling what its rules forbid. It stops nothing when the far side is the party to distrust: a page script that builds `{ type: "call", path: "project.files.delete", args: ["p1"] }` by hand and writes it to the socket never touches a stub, and the serving side's default answer is to run it — with host standing. The same page can send a `sub` frame with `subscriberPath: null` and be treated as a host subscription (`allow`), or assert any module path and receive whatever that path is granted.

The fix is not a field on the frame — anything the frame carries, the peer can set. It is an identity the **host** binds to the channel from something the peer cannot forge: the transport's own authentication. That identity is the `principal` option on `serve()` (and, for the event half only, `grow()`):

```javascript
// serve side — the trusted Node back; one serve() per authenticated socket
const api = await slothlet({
	base: "./api",
	permissions: {
		defaultPolicy: "deny",
		rules: [
			{ caller: "remote.**", target: "host.**", effect: "allow" },
			{
				caller: "remote.renderer",
				target: "project.files.list",
				effect: "allow",
				// resource-scoped: the project named IN THE CALL must be the actor's own
				condition: (ctx, meta) => ctx.actor?.roles?.includes("reader") && meta?.args?.[0] === ctx.actor?.project
			},
			{ caller: "remote.admin", target: "project.**", effect: "allow" }
		],
		events: {
			default: "deny",
			rules: [
				{ caller: "remote.renderer", event: "jobs.*", effect: "allow" },
				{ caller: "remote.renderer.audit", event: "jobs.*", effect: "notify" }, // a narrower grant for one far module
				{ caller: "remote.admin", event: "**", effect: "allow" }
			]
		}
	}
});

wss.on("connection", async (socket, request) => {
	const user = await authenticate(request); // cookie / token / Origin — nothing the page can forge
	await serve(api, createChannel(socket), {
		paths: ["host", "project"],
		principal: {
			path: user.admin ? "remote.admin" : "remote.renderer",
			context: { actor: { id: user.id, roles: user.roles, project: user.project } }
		}
	});
});
```

```javascript
// grow side (the page) — unchanged from a trusted-transport grow
const link = await grow(viewApi, channel);
await viewApi.project.files.list("p1"); // forwards { path: "project.files.list", args: ["p1"] }
```

A principal is `{ path, context? }`. `path` is a dotted caller identity that slothlet's `caller:` globs match — in call rules and event rules alike — validated with the same path guard as a leaf. `context` is the verified per-channel runtime context (the authenticated actor, roles, tenant) that conditional rules, [`requires`-principals](https://github.com/CLDMV/slothlet/blob/master/docs/PERMISSIONS.md#principals) and the leaves themselves see. A bare string is `{ path }`. A function is called synchronously per frame and may answer either form, so a host can rotate identity on re-auth without re-serving; a throw or any other answer denies that one frame. The normalized value is frozen and exposed as `serving.principal`.

### What a principal is, and is not

It is a **rule subject**, not a tree member: `caller: "remote.**"` matches `remote.renderer` whether or not anything is mounted at `remote`, and specificity, layers, conditions, `defaultPolicy`, `seal()` and runtime `addRule` all apply unchanged. It is **not the host** — with a principal, no frame runs with host standing — and **not a module with a file**: the self-call bypass never applies, and a `_private` target is denied to it regardless of the `private.host` policy. Pick a namespace no real module occupies (`remote.*`, `client.*`) so `caller:` globs written for the channel cannot accidentally cover a local module, and vice versa; the vine does not check for collisions, because a host may deliberately want `client.**` rules to cover both. With a principal, `defaultPolicy: "deny"` is the sensible base: `paths` is then the coarse allow-list (what is reachable at all) and the rules are the fine one (who may call it), and both are consulted on every frame.

### Calls — the same frames, three channels

Every `call` frame is judged as `principal.path` calling `path` with the frame's `args`, inside a context scope carrying `principal.context` with every top-level key write-protected — so the actor a leaf reads is the actor the host bound, and neither the leaf nor anything it calls can reassign it (nested fields included: `CONTEXT_KEY_PROTECTED`). The order is `VINE_NO_LEAF` (the surface filter, already public in the `surface` frame) → `VINE_DENIED` (the rules) → `VINE_DATA_ONLY` (the args scan) → invoke → `VINE_DATA_ONLY` (the return scan) → `result`. The gate runs before the args scan because a rule condition is user code that receives `args`; an unauthorized principal's payload never reaches one. `actor` for the `remote.renderer` channel below is `{ id: "u42", roles: ["reader"], project: "p1" }`.

| `call` frame (`path`, `args`)            | channel principal | no principal (trusted transport) | with principal                                                                                  |
| ---------------------------------------- | ----------------- | -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `host.deps.list`, `[]`                   | `remote.renderer` | result                           | result — `remote.** → host.**` allow                                                            |
| `project.files.list`, `["p1"]`           | `remote.renderer` | result                           | result — condition sees `ctx.actor.project === "p1"` **and** `meta.args[0] === "p1"`            |
| `project.files.list`, `["p2"]`           | `remote.renderer` | result                           | error `VINE_DENIED` — condition non-match → `defaultPolicy: "deny"`                             |
| `project.files.delete`, `["p1"]`         | `remote.renderer` | result (host standing)           | error `VINE_DENIED` — no matching allow rule; the leaf never ran                                |
| `project.files.delete`, `["p1"]`         | `remote.admin`    | result                           | result — `remote.admin → project.**` allow                                                      |
| `secrets.dump`, `[]` (outside `paths`)   | any               | error `VINE_NO_LEAF`             | error `VINE_NO_LEAF` — the surface filter is first, unchanged                                   |
| `project.files.list`, `[{ cb() {} }]`    | `remote.renderer` | error `VINE_DATA_ONLY`           | error `VINE_DENIED` — `args[0]` is not the actor's project, and the gate precedes the args scan |
| `project.files.list`, `["p1", () => {}]` | `remote.renderer` | error `VINE_DATA_ONLY`           | error `VINE_DATA_ONLY` — allowed by the rules, then refused as data-only                        |

How the frame was produced makes no difference to the serve side, which is the point:

| how the frame was produced                                                     | grow-side gate (the stub)                 | serve-side gate (the principal)     | net                                                             |
| ------------------------------------------------------------------------------ | ----------------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| view module `self.project.files.delete()` with a grow-side deny rule           | `PERMISSION_DENIED` locally, nothing sent | not reached                         | denied (on a trusted transport too)                             |
| page script sends `{ type: "call", path: "project.files.delete", … }` directly | bypassed                                  | `VINE_DENIED` for `remote.renderer` | **denied** — without a principal it executed with host standing |
| the same raw frame on the `remote.admin` channel                               | bypassed                                  | allowed                             | executed                                                        |

A denial crosses as an error frame whose message names the path only — never the principal — and arrives grow-side, like every remote `VINE_*` code, as a `VineRemoteError` with `.code === "VINE_REMOTE"` and `.remoteCode === "VINE_DENIED"` (see [ERRORS.md](ERRORS.md#the-one-code-that-is-never-adopted-from-the-wire-vine_)). It is a vine code, not slothlet's `PERMISSION_DENIED`: it is the vine refusing on its own account, not the far side's application throwing. Each decision is also audited on the serving instance's lifecycle bus exactly as a real call's would be, with `via: "checkCall"` in the payload: `permission:denied` for a call a rule denies (always emitted), and `permission:default` for one denied only by `defaultPolicy` (emitted under `audit: "verbose"`). A page probing served paths is as visible as any local caller.

### Events — what a `sub` frame gets

With a principal, every far `sub` is resolved as `principal.path` — `null` from the far side is the **channel**, not the host — inside `context.run(principal.context)` when a context is bound, at subscribe and again per emit. The far side's own `subscriberPath` is honoured only when it sits at or under the principal's path, and then only to narrow: the lower of the two levels (`deny` < `notify` < `allow`). A claim anywhere else is ignored and the channel's level is used. So a forged claim can cost the far side deliveries and never gain it any; per-module paths from the far side stay useful as least privilege between well-behaved modules, and nothing more. Rules as above, `default: "deny"`.

| `sub` frame `subscriberPath`                                                        | channel principal | effective identity                                             | no principal                               | with principal                                          |
| ----------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `null` (a far host subscription), event `jobs.done`                                 | `remote.renderer` | `remote.renderer`                                              | **`allow`** (null = host, unconditionally) | `allow` — `remote.renderer → jobs.*`                    |
| `null`, event `billing.paid`                                                        | `remote.renderer` | `remote.renderer`                                              | **`allow`**                                | `deny` — default                                        |
| `"remote.admin"` (forged), event `billing.paid`                                     | `remote.renderer` | `remote.renderer` (the hint is not under the prefix)           | **`allow`** (the rule for `remote.admin`)  | `deny` — the channel's own level                        |
| `"remote.renderer.audit"`, event `jobs.done`                                        | `remote.renderer` | `min(remote.renderer → allow, remote.renderer.audit → notify)` | `notify`                                   | `notify` — the hint narrowed; the payload never crosses |
| `"remote.renderer.audit"` with the grants swapped (channel `notify`, audit `allow`) | `remote.renderer` | `min(notify, allow)`                                           | `allow`                                    | `notify` — the hint cannot widen                        |
| `"events.subscribe"` (a far module's honest path), any event                        | none              | `"events.subscribe"`                                           | per its rule                               | unchanged — no principal, no change                     |

### `grow({ principal })` — the event half on the grow end

The forwarder is symmetric, and the trusted end of a channel is not always the serving end: a Node host that grows leaves out of an untrusted worker plugin still answers that plugin's `sub` frames for host events. `grow(api, channel, { principal })` binds the same identity for that end's event server-half — every far `sub` is resolved as the principal with the same narrowing rules — and nothing else: a grow answers no `call` frames, so only the event-side preconditions apply and `checkCall` is not required.

### What the instance must provide — fail-closed at setup

`serve()` / `grow()` throw a `TypeError` before publishing anything when a principal is given and the instance cannot enforce it:

- the permission system is not enforcing — `api.slothlet.permissions.control.enabled` is not `true` (no `permissions` block, or `control.disable()` was called). A principal on an unenforced instance would gate nothing, which is precisely the silent hole this section exists to close, so it is refused rather than warned about. A later `control.disable()` by the host reopens the gate for principals exactly as it does for local modules — that is the host's own act;
- `api.slothlet.event.resolveLevel` is missing (slothlet < 3.18.0);
- for `serve()`: `api.slothlet.permissions.global.checkCall` is missing. **The call half requires the slothlet release carrying `permissions.global.checkCall(callerPath, targetPath, args)` — [CLDMV/slothlet#508](https://github.com/CLDMV/slothlet/issues/508).** It is the call-side twin of `event.resolveLevel`: it evaluates the rules with the call's own `args` (so a resource-scoped condition and a `requires`-principal mean the same thing over the vine as locally), against the ambient context, treating the caller as a module with no source file, and emits the audit events. The older `global.checkAccess(caller, target)` is a silent query with no call metadata — through it, a condition reading `meta.args` is simply a non-match — which is why the vine does not fall back to it and fails closed instead. On an older slothlet, `serve({ principal })` throws and everything else works as before;
- for `serve()`: `api.slothlet.context.scope` does not work (a `scope: false` instance); for `grow()`, `context.run` does not work when the principal carries a `context`.

Two more things to know. A principal-bearing serve must run on the async (Node) runtime: under `runtime: "live"` (and in browser mode) concurrent scopes on one instance interleave, and one channel's actor could be attributed to another channel's call — bind principals on the Node end of a link. And slothlet 3.20.0 hands an event-rule `condition` the raw context store (`{ context: { actor } , … }`) where a call-rule condition receives the user context (`{ actor }`); an event condition that reads the actor should read `ctx.actor ?? ctx.context?.actor` until that is reconciled upstream.

---

## The gate fires before the stub body runs

This is the property that makes the phrase "gated exactly like a real leaf" load-bearing rather than aspirational: a denied call is stopped by slothlet **before** the vine's forwarding stub is invoked at all, which means the `call` frame is never built and nothing is ever sent. The far side's own state is untouched — no counter increments, no side effect runs, nothing crosses the boundary.

```javascript
// serve-side leaf:
let calls = 0;
export function secretCallCount() {
	return calls;
}
export function secret() {
	calls++;
	return "top-secret";
}
```

```javascript
// grow side, with a deny rule on `tools.secret`:
await expect(growApi.caller.secret()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
await growApi.tools.secretCallCount(); // 0 — the call never reached the far side at all
```

A `PERMISSION_DENIED` error is slothlet's own error, not a `VineError` — see [ERRORS.md](ERRORS.md) for the vine's own `VINE_*` taxonomy, which this is deliberately not part of.

---

## Rules target the local path, same as any leaf

Because a stub is mounted at the callee's **identical** dotted path, a permission rule needs nothing vine-specific — write it exactly as you would to gate a real leaf at that same path. There's no separate "this is a vine boundary" syntax, and nothing to configure on `grow()`/`serve()` for this: the gating is a consequence of how stubs are mounted, not a feature vine turns on.

```javascript
// Deny every module except `admin.**` from reaching anything under a vine-mounted `exts` tree:
permissions: {
	defaultPolicy: "allow",
	rules: [{ caller: "**", target: "exts.**", effect: "deny", except: [{ caller: "admin.**" }] }];
}
```

If the far side later publishes a leaf your rules don't yet mention, the rule engine's own default policy decides — nothing about receiving a new leaf over the vine changes how that decision is made.

---

## See also

- [ERRORS.md](ERRORS.md) — the vine's own `VINE_*` codes, as distinct from slothlet's `PERMISSION_DENIED`.
- [CONFIGURATION.md](CONFIGURATION.md) — `grow()`'s `paths` option, a _separate_ filter (which far leaves get mounted at all) from permissions (who may call a mounted one).
- Slothlet's own [Permission System](https://github.com/CLDMV/slothlet/blob/master/docs/PERMISSIONS.md) and [Permission Conditions](https://github.com/CLDMV/slothlet/blob/master/docs/PERMISSIONS-CONDITIONS.md) docs — rule syntax, glob patterns, the `condition` field, runtime management.
