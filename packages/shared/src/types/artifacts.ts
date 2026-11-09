export type ArtifactFormat = "markdown" | "html" | "openui";

export interface SavedArtifact {
  id: string;
  title: string;
  projectId: string | null;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactVersion {
  artifactId: string;
  version: number;
  content: string;
  format: ArtifactFormat;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  createdAt: string;
}

export type ArtifactVersionInfo = Omit<ArtifactVersion, "content">;

export interface ArtifactDetail {
  artifact: SavedArtifact;
  version: ArtifactVersion;
  versions: ArtifactVersionInfo[];
}

export interface ArtifactMutationResult {
  artifact: SavedArtifact;
  version: ArtifactVersion;
}

export interface CreateArtifactInput {
  title?: string;
  sourceMessageId?: string;
  content?: string;
  format?: ArtifactFormat;
  projectId?: string | null;
}

export interface AppendArtifactVersionInput {
  expectedVersion: number;
  sourceMessageId?: string;
  content?: string;
  format?: ArtifactFormat;
}

export interface UpdateArtifactInput {
  title: string;
  projectId?: string | null;
}
