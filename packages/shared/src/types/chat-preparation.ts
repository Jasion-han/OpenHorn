export interface ChatPreparationRequest {
  conversationId: string;
  content: string;
  attachments?: string[];
  preparationToken?: string;
  /** Persist a stopped round without starting retrieval or answer generation. */
  stoppedBeforeStart?: boolean;
  stoppedAttachmentMeta?: Array<{ fileName: string; fileType?: string; fileSize?: number }>;
}
export interface ChatPreparationCancelRequest {
  conversationId: string;
  preparationToken: string;
}
