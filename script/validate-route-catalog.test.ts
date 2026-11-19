import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const routes = [
  "code-review",
  "debug-repair",
  "performance-audit",
  "product-planning",
  "project-development",
  "security-audit",
  "technical-design",
].flatMap((domain) => [`${domain}-full.yaml`, `${domain}-lite.yaml`])
routes.push(
  "release-route.yaml",
  "research-to-prototype.yaml",
  "ultra-flow-route.yaml",
)

// The strict-gate checks drive the pinned runtime's authoring module: CI sets
// GRAPHAGENT_RUNTIME to its checkout of the commit in runtime-compat.json;
// locally they run when that variable (or ./runtime) points at a checkout
// with its dependencies installed.
const runtime = [process.env.GRAPHAGENT_RUNTIME, join(root, "runtime")]
  .filter((candidate): candidate is string => candidate !== undefined)
  .find((candidate) =>
    existsSync(join(candidate, "packages", "graphagent", "src", "dag", "authoring.ts")),
  )
const withRuntime = test.skipIf(runtime === undefined)

let fixture: string

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "dag-route-catalog-"))
  await Promise.all(
    routes.map((route) =>
      Bun.write(join(fixture, route), Bun.file(join(root, route))),
    ),
  )
})

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true })
})

describe("route catalog guardrails", () => {
  test("rejects a lite gate disconnected from its qualification evidence", async () => {
    await rewrite(
      "project-development-lite.yaml",
      "depends_on: [lite-development-plan]",
      "depends_on: []",
    )

    const result = await validate()
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      "lite-scope gate must depend on its qualification evidence",
    )
  })

  test("rejects executable work before the lite qualification gate", async () => {
    await rewrite("project-development-lite.yaml", "kind: plan", "kind: coding")

    const result = await validate()
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      "lite qualification must be a non-reporting evidence block",
    )
  })

  test("rejects post-gate work that can bypass the gate-dominated chain", async () => {
    await rewrite(
      "project-development-lite.yaml",
      "depends_on: [lite-development-gate]",
      "depends_on: [lite-development-plan]",
    )

    const result = await validate()
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("has work outside its lite-scope gate")
  })

  test("rejects child instructions that select another saved route", async () => {
    await rewrite(
      "project-development-lite.yaml",
      "route and control changes.",
      "route and control changes. Also return next_action: { operation: replan, route: project-development-full }.",
    )

    const result = await validate()
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      "must not select another route or control action inside a child block",
    )
  })

  test("ignores hidden delivery dotfiles when checking the catalog", async () => {
    await Bun.write(join(fixture, ".specgit.yaml"), "version: 1\n")

    const result = await validate()
    expect(result.exitCode).toBe(0)
  })

  test("still rejects a visible yaml outside the catalog", async () => {
    await Bun.write(
      join(fixture, "extra-route.yaml"),
      "config:\n  name: extra-route\n",
    )

    const result = await validate()
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Route catalog must contain exactly")
  })

  test("rejects a worker_type outside the compatible runtime agent catalog", async () => {
    await rewrite(
      "research-to-prototype.yaml",
      "worker_type: architect",
      "worker_type: verify",
    )

    const result = await validate()
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      "not in the compatible runtime agent catalog",
    )
  })

  test("rejects an acceptance item that names a deliverable produced after the reviews", async () => {
    await rewrite(
      "project-development-full.yaml",
      /(- id: AC3\n      text: >-\n)(?: {8}.*\n)+/,
      "$1        The final report states the changed modules and review verdicts.\n",
    )

    const result = await validate()
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('acceptance AC3 names "report"')
    expect(result.stderr).toContain("runs after the reviews")
  })

  test("takes the deliverable word from the synthesize block id", async () => {
    await rewrite(
      "product-planning-full.yaml",
      /(- id: AC1\n      text: >-\n)(?: {8}.*\n)+/,
      "$1        The brief names the user and the problem.\n",
    )

    const result = await validate()
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('acceptance AC1 names "brief"')
  })

  test("rejects a compose block whose composer is outside the compatible runtime agent catalog", async () => {
    await rewrite(
      "research-to-prototype.yaml",
      "worker_type: surveyor",
      "worker_type: surveyer",
    )

    const result = await validate()
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      'worker type "surveyer" is not in the compatible runtime agent catalog',
    )
  })
})

describe("authored and strict review gates", () => {
  test("a runtime checkout is available in CI", () => {
    // Without it the strict checks below would be skipped, not run.
    if (process.env.CI) expect(runtime).toBeDefined()
  })

  withRuntime("accepts every template under both gates", async () => {
    const result = await validate(runtime)
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("authored and strict review gates")
  })

  withRuntime("rejects a review block without the completeness lens that its authored gate accepts", async () => {
    await rewrite(
      "code-review-full.yaml",
      "lenses: [standards, intent, completeness]",
      "lenses: [standards, intent]",
    )

    const result = await validate(runtime)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("[strict]")
    expect(result.stderr).toContain(
      'Review block "whole-change-decision" must include the completeness lens',
    )
    expect(result.stderr).not.toContain("[authored]")
  })

  withRuntime("rejects a writing template that declares no acceptance items", async () => {
    await rewrite(
      "project-development-lite.yaml",
      /^  acceptance:\n(?: {4,}.*\n)+/m,
      "",
    )

    const result = await validate(runtime)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("[strict]")
    expect(result.stderr).toContain("must declare config.acceptance")
    expect(result.stderr).not.toContain("[authored]")
  })

  withRuntime("rejects a diff review that feeds no required final gate", async () => {
    await rewrite(
      "research-to-prototype.yaml",
      /\n    - id: prototype-report\n[\s\S]*$/,
      "\n",
    )

    const result = await validate(runtime)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("[strict]")
    expect(result.stderr).toContain("must feed a required final gate")
    expect(result.stderr).not.toContain("[authored]")
  })

  withRuntime("rejects a hand-written node with a write-capable worker", async () => {
    await Bun.write(
      join(fixture, "release-route.yaml"),
      [
        "inputs:",
        "  objective:",
        "    description: The release to assemble.",
        "config:",
        "  name: release-route",
        "  nodes:",
        "    - id: publish",
        "      name: publish",
        "      worker_type: general",
        "      depends_on: []",
        "      prompt_template:",
        '        inline: "Publish: {{objective}}"',
        "",
      ].join("\n"),
    )

    const result = await validate(runtime)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("[strict]")
    expect(result.stderr).toContain('node "publish" is write-capable ("general")')
    expect(result.stderr).not.toContain("[authored]")
  })

  test("fails clearly when the runtime checkout is missing", async () => {
    const result = await validate(join(fixture, "no-runtime"))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("pass a runtime checkout")
  })
})

async function rewrite(file: string, before: string | RegExp, after: string) {
  const source = await Bun.file(join(fixture, file)).text()
  if (typeof before === "string") expect(source).toContain(before)
  else expect(source).toMatch(before)
  await Bun.write(join(fixture, file), source.replace(before, after))
}

async function validate(runtimeDir?: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(root, "script", "validate-route-catalog.ts"),
      fixture,
      ...(runtimeDir !== undefined ? [runtimeDir] : []),
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}
