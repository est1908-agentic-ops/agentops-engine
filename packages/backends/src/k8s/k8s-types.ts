export interface V1Job {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    ttlSecondsAfterFinished?: number;
    backoffLimit?: number;
    activeDeadlineSeconds?: number;
    template?: {
      spec?: {
        restartPolicy?: string;
        securityContext?: { runAsNonRoot?: boolean };
        volumes?: Array<{ name: string; persistentVolumeClaim?: { claimName: string } }>;
        containers?: Array<{
          name: string;
          image: string;
          workingDir?: string;
          command?: string[];
          env?: Array<{ name: string; value: string }>;
          envFrom?: Array<{ secretRef?: { name: string } }>;
          securityContext?: { runAsNonRoot?: boolean; allowPrivilegeEscalation?: boolean };
          volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
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
