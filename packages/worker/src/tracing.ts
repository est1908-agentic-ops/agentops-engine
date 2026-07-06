import { trace, type Tracer } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { BatchSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { makeWorkflowExporter } from '@temporalio/interceptors-opentelemetry/lib/worker';
import type { InjectedSink } from '@temporalio/worker';
import type { OpenTelemetryWorkflowExporter } from '@temporalio/interceptors-opentelemetry/lib/workflow';

export interface TracingSetup {
  tracer: Tracer;
  workflowExporterSink: InjectedSink<OpenTelemetryWorkflowExporter>;
  /** Flushes pending spans without shutting down -- for tests that need to read an in-memory exporter mid-run. */
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export interface SetupTracingOptions {
  /** Injectable for tests — defaults to a real OTLP/gRPC exporter reading OTEL_EXPORTER_OTLP_ENDPOINT. */
  exporter?: SpanExporter;
  serviceName?: string;
}

/**
 * No-op (returns undefined) unless OTEL_EXPORTER_OTLP_ENDPOINT is set or an
 * exporter is passed explicitly — matches this file's existing
 * KUBERNETES_SERVICE_HOST/registry-presence pattern: the environment tells
 * the truth, no separate flag to remember. When unset, every
 * `trace.getTracer(...)` call in the process resolves to @opentelemetry/api's
 * built-in no-op tracer, so callers never need to branch on whether tracing
 * is enabled.
 */
export function setupTracing(options: SetupTracingOptions = {}): TracingSetup | undefined {
  if (!options.exporter && !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return undefined;
  }

  const resource = new Resource({ 'service.name': options.serviceName ?? 'agentops-worker' });
  const exporter = options.exporter ?? new OTLPTraceExporter();
  const processor = new BatchSpanProcessor(exporter);

  const provider = new NodeTracerProvider({ resource, spanProcessors: [processor] });
  provider.register();

  return {
    tracer: trace.getTracer('agentops-worker'),
    // makeWorkflowExporter's SpanExporter overload is deprecated in favor of
    // passing a SpanProcessor directly (verified against the installed
    // version's worker/index.d.ts) — reusing the same processor here means
    // activity-native spans and the sandboxed workflow's serialized spans
    // both flow through one export pipeline instead of two.
    workflowExporterSink: makeWorkflowExporter(processor, resource),
    forceFlush: async () => {
      await provider.forceFlush();
    },
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}
