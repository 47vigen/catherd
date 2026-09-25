import { expect, test } from "bun:test"
import { useMemo, useRef, useState } from "react"
import type { BoxRenderable, InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { registerTimedLeader, registerCommaBindings } from "@opentui/keymap/addons/opentui"
import { KeymapProvider, useBindings, useActiveKeys } from "@opentui/keymap/react"
import { useRenderer } from "@opentui/react"

const calls: string[] = []

function List() {
  const ref = useRef<BoxRenderable>(null)
  useBindings(
    () => ({
      targetRef: ref,
      targetMode: "focus-within",
      bindings: [
        { key: "j,down", cmd: () => void calls.push("list.down"), desc: "move down" },
        { key: "space", cmd: () => void calls.push("list.toggle"), desc: "toggle" },
      ],
    }),
    [],
  )
  return (
    <box ref={ref} id="list" focusable height={2}>
      <text>list</text>
    </box>
  )
}

function Footer() {
  const active = useActiveKeys({ includeMetadata: true })
  return <text>{active.map((k) => `${k.display}:${(k.bindingAttrs as any)?.desc ?? ""}`).join(" ")}</text>
}

function App(props: { expose: (x: { list: () => void; input: () => void }) => void }) {
  const [value, setValue] = useState("")
  const inputRef = useRef<InputRenderable>(null)
  const renderer = useRenderer()
  useBindings(
    () => ({
      bindings: [
        { key: "ctrl+p", cmd: () => void calls.push("palette"), desc: "commands" },
        { key: "<leader>n", cmd: () => void calls.push("leader.new"), desc: "new profile" },
      ],
    }),
    [],
  )
  useBindings(
    () => ({ enabled: () => !renderer.currentFocusedEditor, bindings: [{ key: "q", cmd: () => void calls.push("GLOBAL-q"), desc: "quit" }] }),
    [],
  )
  props.expose({
    list: () => (renderer.root.findDescendantById("list") as any)?.focus(),
    input: () => inputRef.current?.focus(),
  })
  return (
    <box flexDirection="column">
      <List />
      <input ref={inputRef} value={value} onInput={setValue} width={20} />
      <text>value={value}</text>
      <Footer />
    </box>
  )
}

function Root(props: { expose: (x: { list: () => void; input: () => void }) => void }) {
  const renderer = useRenderer()
  const keymap = useMemo(() => {
    const k = createDefaultOpenTuiKeymap(renderer)
    registerCommaBindings(k)
    registerTimedLeader(k, { trigger: "ctrl+x", name: "leader", timeoutMs: 2000 })
    return k
  }, [renderer])
  return (
    <KeymapProvider keymap={keymap}>
      <App expose={props.expose} />
    </KeymapProvider>
  )
}

const tick = () => new Promise((r) => setTimeout(r, 20))

test("focus-scoped letters, global chords, leader, input owns printable keys (React)", async () => {
  let focus!: { list: () => void; input: () => void }
  const setup = await testRender(<Root expose={(x) => (focus = x)} />, { width: 60, height: 8 })
  await setup.renderOnce(); await tick()
  focus.list()
  await setup.renderOnce(); await tick()
  setup.mockInput.pressKey("j")
  setup.mockInput.pressKey(" ")
  setup.mockInput.pressKey("p", { ctrl: true })
  setup.mockInput.pressKey("x", { ctrl: true })
  setup.mockInput.pressKey("n")
  setup.mockInput.pressKey("q")
  await tick(); await setup.renderOnce()
  const listFrame = setup.captureCharFrame()
  focus.input()
  await setup.renderOnce(); await tick()
  await setup.mockInput.typeText("jk nq")
  setup.mockInput.pressKey("p", { ctrl: true })
  await tick(); await setup.renderOnce()
  const inputFrame = setup.captureCharFrame()
  console.log(calls, "\n--- list focused\n" + listFrame + "\n--- input focused\n" + inputFrame)
  expect(calls).toEqual(["list.down", "list.toggle", "palette", "leader.new", "GLOBAL-q", "palette"])
  expect(inputFrame).toContain("value=jk nq")
  setup.renderer.destroy()
})
