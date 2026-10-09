export interface ReferenceImage {
  id: string;
  name: string;
  description: string;
  filePath?: string;
  tags: string[];
  metadata?: Record<string, string | number | boolean | null | undefined>;
  createdAt: string;
  updatedAt: string;
}
