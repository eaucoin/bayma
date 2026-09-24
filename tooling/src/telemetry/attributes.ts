// The names development telemetry records under. Attributes follow
// OpenTelemetry's semantic conventions where one fits; those still in
// development are copied here rather than imported from the conventions'
// incubating entry point, as the conventions ask, since they may change.
// What no convention covers is under `bayma.dev.`.

export const ATTR = {
  // Stable conventions.
  serviceName: "service.name",
  serviceVersion: "service.version",
  errorType: "error.type",
  urlFull: "url.full",
  // Conventions in development.
  processCommandArgs: "process.command_args",
  processExecutableName: "process.executable.name",
  processExitCode: "process.exit.code",
  processPid: "process.pid",
  processWorkingDirectory: "process.working_directory",
  logIostream: "log.iostream",
  vcsRepositoryUrlFull: "vcs.repository.url.full",
  vcsRefHeadName: "vcs.ref.head.name",
  vcsRefHeadRevision: "vcs.ref.head.revision",
  cicdPipelineName: "cicd.pipeline.name",
  cicdPipelineRunId: "cicd.pipeline.run.id",
  cicdPipelineRunUrlFull: "cicd.pipeline.run.url.full",
  cicdPipelineTaskName: "cicd.pipeline.task.name",
  testSuiteName: "test.suite.name",
  testCaseName: "test.case.name",
  testCaseResultStatus: "test.case.result.status",
  codeFilePath: "code.file.path",
  codeLineNumber: "code.line.number",
  // bayma's own.
  command: "bayma.dev.command",
  provisionStep: "bayma.dev.provision.step",
  provisionDirectory: "bayma.dev.provision.directory",
  provisionCached: "bayma.dev.provision.cached",
  downloadLabel: "bayma.dev.download.label",
  downloadCached: "bayma.dev.download.cached",
  artifact: "bayma.dev.artifact",
  testRunner: "bayma.dev.test.runner",
  serverTransport: "bayma.dev.server.transport",
} as const;

export const METRIC = {
  commandDuration: "bayma.dev.command.duration",
  processDuration: "bayma.dev.process.duration",
  provisionLookups: "bayma.dev.provision.lookups",
  downloadDuration: "bayma.dev.download.duration",
  downloadSize: "bayma.dev.download.size",
  artifactSize: "bayma.dev.artifact.size",
  testCases: "bayma.dev.test.cases",
  testDuration: "bayma.dev.test.duration",
} as const;

/** The instrumentation scope every signal is recorded under. */
export const SCOPE = "bayma-development";
