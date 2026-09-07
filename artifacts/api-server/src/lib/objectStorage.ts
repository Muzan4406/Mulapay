import { randomUUID } from "node:crypto";

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
  }
}

type PendingUpload = {
  userId: string;
  objectPath: string;
  contentType: string;
  size: number;
  expiresAt: number;
};

export class ObjectStorageService {
  private readonly pendingUploads = new Map<string, PendingUpload>();
  private readonly bucketName = "kyc-documents";

  private getConfig() {
    const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !serviceRoleKey) throw new Error("Supabase Storage is not configured.");
    return { url, serviceRoleKey };
  }

  private headers(contentType?: string) {
    const { serviceRoleKey } = this.getConfig();
    return {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      ...(contentType ? { "Content-Type": contentType } : {}),
    };
  }

  private storageUrl(objectName?: string) {
    const { url } = this.getConfig();
    const suffix = objectName
      ? `/${objectName.split("/").map((part) => encodeURIComponent(part)).join("/")}`
      : "";
    return `${url}/storage/v1/object/${encodeURIComponent(this.bucketName)}${suffix}`;
  }

  private async ensureBucket() {
    const { url } = this.getConfig();
    const response = await fetch(`${url}/storage/v1/bucket`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: this.bucketName, name: this.bucketName, public: false }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok && response.status !== 409) {
      throw new Error(`Unable to provision Supabase Storage bucket (HTTP ${response.status}).`);
    }
  }

  async createUploadSession(userId: string, metadata: { contentType: string; size: number }) {
    await this.ensureBucket();
    const token = randomUUID();
    const objectPath = `/objects/kyc/${randomUUID()}`;
    this.pendingUploads.set(token, {
      userId,
      objectPath,
      contentType: metadata.contentType,
      size: metadata.size,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    return { uploadURL: `/api/v1/kyc/uploads/${token}`, objectPath };
  }

  async uploadPendingObject(token: string, userId: string, body: Buffer, contentType: string) {
    const pending = this.pendingUploads.get(token);
    if (!pending || pending.userId !== userId || pending.expiresAt < Date.now()) {
      this.pendingUploads.delete(token);
      throw new ObjectNotFoundError();
    }
    if (pending.contentType !== contentType || pending.size !== body.length) {
      throw new Error("KYC upload metadata does not match the uploaded file.");
    }
    const objectName = pending.objectPath.slice("/objects/".length);
    const response = await fetch(this.storageUrl(objectName), {
      method: "POST",
      headers: { ...this.headers(contentType), "x-upsert": "false" },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Supabase Storage rejected the KYC document (HTTP ${response.status}).`);
    }
    this.pendingUploads.delete(token);
    return pending.objectPath;
  }

  async getObjectEntityFile(objectPath: string) {
    if (!/^\/objects\/kyc\/[a-zA-Z0-9-]+$/.test(objectPath)) throw new ObjectNotFoundError();
    const response = await fetch(this.storageUrl(objectPath.slice("/objects/".length)), {
      method: "HEAD",
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) throw new ObjectNotFoundError();
    if (!response.ok) throw new Error(`Unable to verify Supabase Storage object (HTTP ${response.status}).`);
    return objectPath;
  }

  async downloadObject(objectPath: string) {
    const response = await fetch(this.storageUrl(objectPath.slice("/objects/".length)), {
      headers: this.headers(),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 404) throw new ObjectNotFoundError();
    if (!response.ok || !response.body) {
      throw new Error(`Unable to download Supabase Storage object (HTTP ${response.status}).`);
    }
    return {
      stream: response.body,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      contentLength: response.headers.get("content-length"),
    };
  }
}