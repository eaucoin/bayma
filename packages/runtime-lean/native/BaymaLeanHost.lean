import Lean.Elab.Frontend
import Std.Sync.Channel

/-!
The bayma host for Lean: bayma's line protocol in front of Lean's own
frontend. A session is one command state, and each exec elaborates a cell on
the state the one before it left.

A checkpoint keeps a session whole: what it declared, as the module data Lean
writes an `.olean` from, so its definitions, compiled code, instances,
attributes, and every other extension's entries come back; and the scopes it
had open. A host restoring one imports that data as modules.
-/

open Lean Elab System

namespace BaymaLeanHost

def prompt : String := "BAYMA> "

/-- Framing headroom below the core's 64 KiB message ceiling, as every host
leaves, so the host's own truncation is the one that shows. -/
def maxMessageBytes : Nat := 60 * 1024

def truncationMarker : String := "…Bayma truncated runtime message…"

def checkpointCodec : String := "lean-environment-v1"

/-- `text`, with its middle cut out to fit `maxMessageBytes`. -/
def bounded (text : String) : String := Id.run do
  let bytes := text.toUTF8
  if bytes.size ≤ maxMessageBytes then return text
  let continuation (index : Nat) : Bool := bytes[index]! &&& 0xC0 == 0x80
  let payload := maxMessageBytes - truncationMarker.utf8ByteSize
  let mut left := payload / 2
  while left > 0 && continuation left do left := left - 1
  let mut right := bytes.size - (payload - payload / 2)
  while right < bytes.size && continuation right do right := right + 1
  return String.fromUTF8! (bytes.extract 0 left) ++ truncationMarker ++
    String.fromUTF8! (bytes.extract right bytes.size)

/-- What one exec asks for: the cell, and where its checkpoint comes from and
goes. -/
structure Spec where
  eventPrefix : String
  code : String
  checkpointed : Bool
  /-- The checkpoint a host starting on a checkpointed session restores. -/
  restorePath? : Option FilePath
  checkpointPath : FilePath

def Spec.parse (raw : String) : Except String Spec := do
  let json ← Json.parse raw
  let version ← json.getObjValAs? Nat "schema_version"
  unless version == 1 do
    throw s!"unsupported Lean execution protocol version {version}"
  let mode ← json.getObjValAs? String "durability_mode"
  unless mode == "ephemeral" || mode == "checkpointed" do
    throw s!"unsupported durability mode {mode}"
  let restorePath? ← match json.getObjVal? "restore_path" with
    | .ok .null | .error _ => pure none
    | .ok path => some <$> (fromJson? path : Except String String)
  return {
    eventPrefix := ← json.getObjValAs? String "event_prefix"
    code := ← json.getObjValAs? String "code"
    checkpointed := mode == "checkpointed"
    restorePath? := restorePath?.map (⟨·⟩)
    checkpointPath := ⟨← json.getObjValAs? String "checkpoint_output_path"⟩
  }

/-- How every cell elaborates. Stderr is a stream rather than messages, so what
a cell writes there reaches the exec's stderr; and elaboration is synchronous,
so everything a command does happens on this thread, where `captured`
redirects its streams, and reports to this command's message log. -/
def cellOptions : Options :=
  Options.empty |>.setBool `stderrAsMessages false |>.setBool `Elab.async false

def cellContext : Command.Context :=
  { fileName := "<cell>", fileMap := default, snap? := none, cancelTk? := none }

open Frontend in
/-- Parses and elaborates the input's commands, one at a time, collecting each
one's messages, which Lean keeps only until the next command. -/
partial def elaborateCommands (messages : MessageLog) : FrontendM MessageLog := do
  updateCmdPos
  let state ← getCommandState
  let scope := state.scopes.head!
  let context := { env := state.env, options := scope.opts,
                   currNamespace := scope.currNamespace, openDecls := scope.openDecls }
  let (command, parserState, parsed) :=
    Parser.parseCommand (← read).inputCtx context (← getParserState) {}
  setParserState parserState
  elabCommandAtFrontend command
  let messages := messages ++ parsed ++ (← getCommandState).messages
  if Parser.isTerminalCommand command then return messages
  elaborateCommands messages

def decode (bytes : ByteArray) : String :=
  (String.fromUTF8? bytes).getD "(output that is not UTF-8)"

/-- Runs `x` with its stdout and stderr captured. -/
def captured (x : IO α) : IO (α × String × String) := do
  let stdout ← IO.mkRef ({} : IO.FS.Stream.Buffer)
  let stderr ← IO.mkRef ({} : IO.FS.Stream.Buffer)
  let value ← IO.withStdout (IO.FS.Stream.ofBuffer stdout) <|
    IO.withStderr (IO.FS.Stream.ofBuffer stderr) x
  return (value, decode (← stdout.get).data, decode (← stderr.get).data)

/-- Everything a checkpoint keeps. -/
structure Checkpoint where
  /-- The imports of the session's first cell. -/
  imports : Array Import
  /-- What the session declared, as module data: one part for each process
  the session has run in. -/
  parts : Array (Name × ModuleData)
  /-- The command state apart from its environment and what each command
  resets. -/
  scopes : List Command.Scope
  usedQuotCtxts : NameSet
  nextMacroScope : MacroScope
  maxRecDepth : Nat
  ngen : NameGenerator
  auxDeclNGen : DeclNameGenerator

/-- The module a part of a session is imported as. -/
def partName (index : Nat) : Name := .str `BaymaSession s!"part{index}"

/-- A session: its command state, once it has one, the imports its first cell
made, and the parts restored into it, which its environment imports. -/
structure Session where
  state? : Option Command.State := none
  imports : Array Import := #[]
  restored : Array (Name × ModuleData) := #[]
  /-- The memory of every restored checkpoint, which `restored` refers to. -/
  regions : Array CompactedRegion := #[]

/-- Elaborates `code` in the session, or, for its first cell, on the
environment the cell's imports make; the session after, and the cell's
messages. -/
def Session.elaborate (session : Session) (code : String) :
    IO (Session × MessageLog) := do
  let inputCtx := Parser.mkInputContext code "<cell>"
  let (session, commandState, parserState, headerMessages) ← match session.state? with
    | some state => pure (session, state, ({} : Parser.ModuleParserState), ({} : MessageLog))
    | none => do
      let (header, parserState, messages) ← Parser.parseHeader inputCtx
      let (env, messages) ← processHeader header cellOptions messages inputCtx
      pure ({ session with imports := env.header.imports }, Command.mkState env {} cellOptions,
        parserState, messages)
  let (messages, state) ← (elaborateCommands headerMessages |>.run { inputCtx }).run
    { commandState, parserState, cmdPos := parserState.pos }
  return ({ session with state? := some state.commandState }, messages)

/-- Writes the session's checkpoint: the parts restored into it, and what
this process declared as one more. -/
def Session.checkpoint (session : Session) (state : Command.State) (path : FilePath) :
    IO Unit := do
  let name := partName (session.restored.size + 1)
  let checkpoint : Checkpoint := {
    imports := session.imports
    parts := session.restored.push (name, ← mkModuleData (state.env.setMainModule name))
    scopes := state.scopes
    usedQuotCtxts := state.usedQuotCtxts
    nextMacroScope := state.nextMacroScope
    maxRecDepth := state.maxRecDepth
    ngen := state.ngen
    auxDeclNGen := state.auxDeclNGen
  }
  -- Lean's module data writer compacts any object that holds no closures.
  saveModuleData path `BaymaCheckpoint (unsafe unsafeCast checkpoint)

/-- Restores the session a checkpoint kept: its parts, written where the
search path finds them, are imported after the session's own imports. -/
unsafe def Session.restore (path scratch : FilePath) : IO Session := do
  let (data, region) ← readModuleData path
  let checkpoint : Checkpoint := unsafeCast data
  for (name, part) in checkpoint.parts do
    let file := modToFilePath scratch name "olean"
    if let some directory := file.parent then IO.FS.createDirAll directory
    saveModuleData file name part
  searchPathRef.modify (scratch :: ·)
  let imports := checkpoint.imports ++
    checkpoint.parts.map fun (name, _) => ({ module := name } : Import)
  let env ← importModules imports cellOptions (loadExts := true)
  let state := { Command.mkState env {} cellOptions with
    scopes := checkpoint.scopes
    usedQuotCtxts := checkpoint.usedQuotCtxts
    nextMacroScope := checkpoint.nextMacroScope
    maxRecDepth := checkpoint.maxRecDepth
    ngen := checkpoint.ngen
    auxDeclNGen := checkpoint.auxDeclNGen }
  -- Open namespaces' scoped entries are active in the session, as they were.
  let activate : Command.CommandElabM Unit := do
    for openDecl in ← getOpenDecls do
      if let .simple ns _ := openDecl then activateScoped ns
  let state ← match ← (activate cellContext |>.run state).toIO' with
    | .ok ((), state) => pure state
    | .error error => throw <| IO.userError (← error.toMessageData.toString)
  return { state? := some state, imports := checkpoint.imports,
           restored := checkpoint.parts, regions := #[region] }

/-- Where the protocol goes: the process's own stdout, which cells never see. -/
structure Host where
  out : IO.FS.Stream
  /-- Where restored checkpoints' parts are written, for this process alone. -/
  scratch : FilePath

def Host.write (host : Host) (text : String) : IO Unit := do
  host.out.putStr text
  host.out.flush

def Host.emit (host : Host) (eventPrefix kind : String)
    (fields : List (String × Json) := []) : IO Unit :=
  host.write (eventPrefix ++ (Json.mkObj (("kind", kind) :: fields)).compress ++ "\n")

def Host.emitText (host : Host) (eventPrefix kind text : String) : IO Unit :=
  unless text.isEmpty do host.emit eventPrefix kind [("text", bounded text)]

/-- Emits a cell's messages. Its last info message, such as a final `#eval`'s
value, is its result; earlier ones, such as what an `#eval` printed, are its
output. -/
def Host.emitMessages (host : Host) (eventPrefix : String) (messages : Array Message) :
    IO Unit := do
  let lastInfo? := (List.range messages.size).reverse.find?
    (messages[·]!.severity == .information)
  for h : index in [0:messages.size] do
    let message := messages[index]
    let text := (← message.data.toString).trimAsciiEnd.toString
    let at_ := s!"{message.pos.line}:{message.pos.column}"
    match message.severity with
    | .information =>
      if lastInfo? == some index then host.emitText eventPrefix "result" text
      else host.emitText eventPrefix "stdout" (text ++ "\n")
    | .warning => host.emitText eventPrefix "stderr" s!"{at_}: warning: {text}\n"
    | .error => host.emitText eventPrefix "error" s!"{at_}: {text}"

def checkpointCommit (path : FilePath) : Json :=
  Json.mkObj [
    ("runtimeId", "lean"),
    ("codecId", checkpointCodec),
    ("codecVersion", 1),
    ("payloadKind", "binary-sidecar"),
    ("payloadPath", path.toString),
    ("compatibility", Json.mkObj [
      ("runtimeVersion", Lean.versionString),
      ("languageVersion", Lean.versionString),
      ("platform", System.Platform.target)])]

unsafe def Host.run (host : Host) (sessionRef : IO.Ref Session) (spec : Spec) : IO Unit := do
  if spec.checkpointed && (← sessionRef.get).state?.isNone then
    if let some path := spec.restorePath? then
      let restored ← try Session.restore path host.scratch catch error =>
        throw <| IO.userError s!"restoring the session's checkpoint {path} failed: {error}"
      sessionRef.set restored
  let ((session, messages), stdout, stderr) ← captured ((← sessionRef.get).elaborate spec.code)
  sessionRef.set session
  host.emitText spec.eventPrefix "stdout" stdout
  host.emitText spec.eventPrefix "stderr" stderr
  host.emitMessages spec.eventPrefix messages.toArray
  if spec.checkpointed then
    if let some state := session.state? then
      session.checkpoint state spec.checkpointPath
      host.emit spec.eventPrefix "checkpoint" [("checkpoint", checkpointCommit spec.checkpointPath)]

/-- Runs the exec a spec file describes; any failure ends the exec in error,
leaving the session's checkpoint as it was, and the session goes on. -/
unsafe def Host.exec (host : Host) (sessionRef : IO.Ref Session) (specPath : String) :
    IO Unit := do
  let raw ← try IO.FS.readFile specPath catch error => do
    IO.eprintln s!"bayma-lean-host: {error}"
    return
  -- The event prefix alone, to report a spec that is otherwise invalid.
  let eventPrefix? := (Json.parse raw >>= (·.getObjValAs? String "event_prefix")).toOption
  match Spec.parse raw, eventPrefix? with
  | .ok spec, _ =>
    try host.run sessionRef spec
    catch error =>
      let text := toString error
      host.emitText spec.eventPrefix "error" (if text.isEmpty then "the exec failed" else text)
      if spec.checkpointed then host.emit spec.eventPrefix "checkpoint-preserved"
    host.emit spec.eventPrefix "done"
  | .error error, some eventPrefix =>
    host.emitText eventPrefix "error" s!"invalid execution spec: {error}"
    host.emit eventPrefix "done"
  | .error error, none => IO.eprintln s!"bayma-lean-host: invalid execution spec: {error}"

def removeScratch (scratch : FilePath) : IO Unit := do
  if ← scratch.pathExists then IO.FS.removeDirAll scratch

/-- Reads stdin's lines into `lines`, on a thread of its own. Their end means
the server that owns this host is gone, and ends the host, even while a cell
runs. -/
def readLines (lines : Std.Channel.Sync String) (scratch : FilePath) : IO Unit := do
  let stdin ← IO.getStdin
  repeat
    let line ← stdin.getLine
    if line.isEmpty then
      removeScratch scratch
      IO.Process.exit 0
    lines.send line

end BaymaLeanHost

open BaymaLeanHost in
unsafe def main (_ : List String) : IO UInt32 := do
  let some scratchRoot ← IO.getEnv "BAYMA_LEAN_SCRATCH_DIR" | do
    IO.eprintln "bayma-lean-host: BAYMA_LEAN_SCRATCH_DIR is required"
    return 1
  initSearchPath (← findSysroot)
  enableInitializersExecution
  let scratch : FilePath := scratchRoot / s!"{← IO.Process.getPID}"
  let host : Host := { out := ← IO.getStdout, scratch }
  let session ← IO.mkRef ({} : Session)
  let lines ← Std.Channel.Sync.new
  discard <| IO.asTask (readLines lines scratch) .dedicated
  host.write prompt
  repeat
    let line := (← lines.recv).trimAsciiEnd.toString
    if let some specPath := line.dropPrefix? ":exec " then
      host.exec session specPath.toString
    else if let some nonce := line.dropPrefix? ":probe " then
      host.write s!"__BAYMA_READY_{nonce}__\n"
    else if line == ":shutdown" then
      break
    else if !line.isEmpty then
      IO.eprintln "bayma-lean-host: unknown protocol command"
    host.write prompt
  removeScratch scratch
  return 0
