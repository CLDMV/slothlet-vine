# Permissions

The vine doesn't have its own permission system — it doesn't need one. A grown stub is mounted into the local slothlet instance at the callee's identical dotted path, using the same `api.slothlet.api.add()` a real module would use to add a leaf at runtime. Slothlet cannot tell a forwarding stub from a real leaf, **including its permission identity**, so a rule targeting `exts.foo.bar` gates the stub exactly as it would gate the real thing — before the stub body runs, before anything crosses the wire.

This page is about that interaction specifically. For the permission system itself — rule syntax, glob patterns, the `condition` field — see slothlet's own [`docs/PERMISSIONS.md`](https://github.com/CLDMV/slothlet/blob/master/docs/PERMISSIONS.md) and [`docs/PERMISSIONS-CONDITIONS.md`](https://github.com/CLDMV/slothlet/blob/master/docs/PERMISSIONS-CONDITIONS.md).

---

## Who is checked, and who isn't

Slothlet's permission rules gate calls made by a **module** — `self.exts.foo.bar()` from inside some other module's code. A call made through the bound handle `slothlet()` itself returned — the host — carries host standing and is **not checked**. That carve-out is slothlet's own design, not a vine gap, but it means "permission-gated" specifically describes module-initiated calls. A host that forwards a caller's request on someone else's behalf is responsible for its own authorization before it does; the vine doesn't add one on top.

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
