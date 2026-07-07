export type V1ReadinessProbe = { exec: { command: string[] } } | { tcpSocket: { port: number } };

export interface V1InitContainer {
  name: string;
  image: string;
  restartPolicy?: 'Always';
  env?: Array<{ name: string; value: string }>;
  readinessProbe?: V1ReadinessProbe;
}

export interface V1Job {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    ttlSecondsAfterFinished?: number;
    backoffLimit?: number;
    activeDeadlineSeconds?: number;
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec?: {
        restartPolicy?: string;
        serviceAccountName?: string;
        securityContext?: { runAsNonRoot?: boolean; runAsUser?: number };
        imagePullSecrets?: Array<{ name: string }>;
        volumes?: Array<{ name: string; persistentVolumeClaim?: { claimName: string } }>;
        initContainers?: V1InitContainer[];
        containers?: Array<{
          name: string;
          image: string;
          workingDir?: string;
          command?: string[];
          env?: Array<{ name: string; value: string }>;
          envFrom?: Array<{ secretRef?: { name: string } }>;
          securityContext?: { runAsNonRoot?: boolean; runAsUser?: number; allowPrivilegeEscalation?: boolean };
          volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
          readinessProbe?: V1ReadinessProbe;
        }>;
      };
    };
  };
  status?: {
    succeeded?: number;
    failed?: number;
    active?: number;
  };
}
