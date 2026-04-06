import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import {
  ImageProcessingError,
  ImageErrorCode,
  ErrorMessages,
} from "../utils/imageErrors";

class SupabaseStorageService {
      /**
       * Get public URL for a staged image by filename
       */
      getPublicStagedUrl(fileName: string): string | null {
        const { data } = this.client.storage
          .from(this.bucketName)
          .getPublicUrl(`staged/${fileName}`);
        return data?.publicUrl || null;
      }
    /**
     * Upload staged image buffer for restage endpoint
     * Returns stagedUrl for the uploaded image
     */
    async uploadStagedImageBuffer(
      imageBuffer: Buffer,
      fileName: string,
      mimeType: string = "image/png"
    ): Promise<{ stagedUrl: string }> {
      const stagedUrl = await this.uploadStagedFromBuffer(imageBuffer, fileName, mimeType);
      return { stagedUrl };
    }
  private client: SupabaseClient;
  private bucketName: string = "elevate-spaces-images";
  private bucketInitialized: boolean = false;

  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    }

    this.client = createClient(supabaseUrl, supabaseServiceKey);
  }

  /**
   * Initialize bucket if it doesn't exist (called automatically before uploads)
   */
  async ensureBucketExists(): Promise<void> {
    if (this.bucketInitialized) return;

    try {
      const { data: buckets, error: listError } = await this.client.storage.listBuckets();
      
      if (listError) {
        logger(`Error listing buckets: ${listError.message}`);
        return;
      }

      const bucketExists = buckets?.some((b) => b.name === this.bucketName);

      if (!bucketExists) {
        logger(`Bucket '${this.bucketName}' not found, creating...`);
        const { error } = await this.client.storage.createBucket(this.bucketName, {
          public: true,
          fileSizeLimit: 10 * 1024 * 1024, // 10MB
          allowedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
        });

        if (error) {
          logger(`Error creating bucket: ${error.message}`);
        } else {
          logger(`Bucket '${this.bucketName}' created successfully`);
          this.bucketInitialized = true;
        }
      } else {
        logger(`Bucket '${this.bucketName}' exists`);
        this.bucketInitialized = true;
      }
    } catch (error) {
      logger(`Error initializing bucket: ${error}`);
    }
  }

  /**
   * Initialize bucket if it doesn't exist (legacy - use ensureBucketExists)
   */
  async initBucket(): Promise<void> {
    return this.ensureBucketExists();
  }

  /**
   * Upload original image to Supabase Storage
   * @throws ImageProcessingError if upload fails
   */
  async uploadOriginal(localFilePath: string): Promise<string> {
    try {
      // Ensure bucket exists before uploading
      await this.ensureBucketExists();

      const fileName = path.basename(localFilePath);
      // Use async file read for better performance
      const fileBuffer = await fs.promises.readFile(localFilePath);
      const mimeType = this.getMimeType(localFilePath);

      const storagePath = `original/${fileName}`;

      const { data, error } = await this.client.storage
        .from(this.bucketName)
        .upload(storagePath, fileBuffer, {
          contentType: mimeType,
          upsert: true,
        });

      if (error) {
        logger(`Error uploading original image: ${error.message}`);
        throw new ImageProcessingError(
          ImageErrorCode.STORAGE_UPLOAD_FAILED,
          ErrorMessages[ImageErrorCode.STORAGE_UPLOAD_FAILED],
          500,
          `Original image upload failed: ${error.message}`
        );
      }

      // Get public URL
      const { data: publicUrl } = this.client.storage
        .from(this.bucketName)
        .getPublicUrl(storagePath);

      logger(`Original image uploaded: ${publicUrl.publicUrl}`);
      return publicUrl.publicUrl;
    } catch (error) {
      logger(`Error uploading original image: ${error}`);
      if (error instanceof ImageProcessingError) {
        throw error;
      }
      throw new ImageProcessingError(
        ImageErrorCode.STORAGE_UPLOAD_FAILED,
        ErrorMessages[ImageErrorCode.STORAGE_UPLOAD_FAILED],
        500,
        error instanceof Error ? error.message : undefined
      );
    }
  }

  /**
   * Upload staged image to Supabase Storage from Buffer (optimized - no disk I/O)
   * @throws ImageProcessingError if upload fails
   */
  async uploadStagedFromBuffer(
    imageBuffer: Buffer,
    fileName: string,
    mimeType: string = "image/png"
  ): Promise<string> {
    try {
      // Ensure bucket exists before uploading
      await this.ensureBucketExists();

      const storagePath = `staged/${fileName}`;

      const { data, error } = await this.client.storage
        .from(this.bucketName)
        .upload(storagePath, imageBuffer, {
          contentType: mimeType,
          upsert: true,
        });

      if (error) {
        logger(`Error uploading staged image: ${error.message}`);
        throw new ImageProcessingError(
          ImageErrorCode.STORAGE_UPLOAD_FAILED,
          ErrorMessages[ImageErrorCode.STORAGE_UPLOAD_FAILED],
          500,
          `Staged image upload failed: ${error.message}`
        );
      }

      // Get public URL
      const { data: publicUrl } = this.client.storage
        .from(this.bucketName)
        .getPublicUrl(storagePath);

      return publicUrl.publicUrl;
    } catch (error) {
      logger(`Error uploading staged image: ${error}`);
      if (error instanceof ImageProcessingError) {
        throw error;
      }
      throw new ImageProcessingError(
        ImageErrorCode.STORAGE_UPLOAD_FAILED,
        ErrorMessages[ImageErrorCode.STORAGE_UPLOAD_FAILED],
        500,
        error instanceof Error ? error.message : undefined
      );
    }
  }

  /**
   * Upload staged image to Supabase Storage from file path (legacy method)
   * @throws ImageProcessingError if upload fails
   */
  async uploadStaged(localFilePath: string): Promise<string> {
    try {
      // Use async file read
      const fileBuffer = await fs.promises.readFile(localFilePath);
      const fileName = path.basename(localFilePath);
      const mimeType = this.getMimeType(localFilePath);
      
      return await this.uploadStagedFromBuffer(fileBuffer, fileName, mimeType);
    } catch (error) {
      logger(`Error uploading staged image: ${error}`);
      if (error instanceof ImageProcessingError) {
        throw error;
      }
      throw new ImageProcessingError(
        ImageErrorCode.STORAGE_UPLOAD_FAILED,
        ErrorMessages[ImageErrorCode.STORAGE_UPLOAD_FAILED],
        500,
        error instanceof Error ? error.message : undefined
      );
    }
  }

  /**
   * Upload both original and staged images after successful processing
   * Throws ImageProcessingError if either upload fails
   */
  async uploadImagePair(
    originalLocalPath: string,
    stagedLocalPath: string
  ): Promise<{ originalUrl: string; stagedUrl: string }> {
    try {
      const [originalUrl, stagedUrl] = await Promise.all([
        this.uploadOriginal(originalLocalPath),
        this.uploadStaged(stagedLocalPath),
      ]);

      return { originalUrl, stagedUrl };
    } catch (error) {
      logger(`Error uploading image pair: ${error}`);
      if (error instanceof ImageProcessingError) {
        throw error;
      }
      throw new ImageProcessingError(
        ImageErrorCode.STORAGE_UPLOAD_FAILED,
        ErrorMessages[ImageErrorCode.STORAGE_UPLOAD_FAILED],
        500,
        error instanceof Error ? error.message : undefined
      );
    }
  }

  /**
   * Upload image pair with staged image from Buffer (optimized - no disk write for staged)
   * Throws ImageProcessingError if either upload fails
   */
  async uploadImagePairWithBuffer(
    originalLocalPath: string,
    stagedImageBuffer: Buffer,
    stagedFileName: string,
    stagedMimeType: string = "image/png"
  ): Promise<{ originalUrl: string; stagedUrl: string }> {
    try {
      const [originalUrl, stagedUrl] = await Promise.all([
        this.uploadOriginal(originalLocalPath),
        this.uploadStagedFromBuffer(stagedImageBuffer, stagedFileName, stagedMimeType),
      ]);

      return { originalUrl, stagedUrl };
    } catch (error) {
      logger(`Error uploading image pair: ${error}`);
      if (error instanceof ImageProcessingError) {
        throw error;
      }
      throw new ImageProcessingError(
        ImageErrorCode.STORAGE_UPLOAD_FAILED,
        ErrorMessages[ImageErrorCode.STORAGE_UPLOAD_FAILED],
        500,
        error instanceof Error ? error.message : undefined
      );
    }
  }

  /**
   * Delete local files after successful upload to Supabase
   */
  cleanupLocalFiles(...filePaths: string[]): void {
    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          logger(`Deleted local file: ${filePath}`);
        }
      } catch (error) {
        logger(`Error deleting local file ${filePath}: ${error}`);
      }
    }
  }

  /**
   * Delete image from Supabase Storage
   */
  async deleteImage(storagePath: string): Promise<boolean> {
    try {
      const { error } = await this.client.storage
        .from(this.bucketName)
        .remove([storagePath]);

      if (error) {
        logger(`Error deleting image: ${error.message}`);
        return false;
      }

      return true;
    } catch (error) {
      logger(`Error deleting image: ${error}`);
      return false;
    }
  }

  /**
   * List recent uploads from Supabase Storage
   * Returns paired original and staged images
   */
  async listRecentUploads(limit: number = 10): Promise<{
    uploads: Array<{
      original: { filename: string; url: string; createdAt: string } | null;
      staged: { filename: string; url: string; createdAt: string } | null;
      createdAt: string;
    }>;
    total: number;
  }> {
    try {
      await this.ensureBucketExists();

      // Get files from both folders
      const [originalResult, stagedResult] = await Promise.all([
        this.client.storage.from(this.bucketName).list("original", {
          limit: limit * 2,
          sortBy: { column: "created_at", order: "desc" },
        }),
        this.client.storage.from(this.bucketName).list("staged", {
          limit: limit * 2,
          sortBy: { column: "created_at", order: "desc" },
        }),
      ]);

      const originalFiles = originalResult.data || [];
      const stagedFiles = stagedResult.data || [];

      // Build URLs for files
      const getPublicUrl = (folder: string, filename: string) => {
        const { data } = this.client.storage
          .from(this.bucketName)
          .getPublicUrl(`${folder}/${filename}`);
        return data.publicUrl;
      };

      // Match original with staged based on timestamp proximity (within 5 minutes)
      const pairedUploads: Array<{
        original: { filename: string; url: string; createdAt: string } | null;
        staged: { filename: string; url: string; createdAt: string } | null;
        createdAt: string;
      }> = [];

      const processedStaged = new Set<string>();

      for (const original of originalFiles) {
        if (!original.name || original.name === ".emptyFolderPlaceholder") continue;

        const originalCreatedAt = original.created_at || new Date().toISOString();

        // Find matching staged file (within 5 minutes)
        const matchingStaged = stagedFiles.find((staged) => {
          if (!staged.name || staged.name === ".emptyFolderPlaceholder") return false;
          if (processedStaged.has(staged.name)) return false;

          const stagedCreatedAt = staged.created_at || new Date().toISOString();
          const timeDiff = Math.abs(
            new Date(stagedCreatedAt).getTime() - new Date(originalCreatedAt).getTime()
          );
          return timeDiff < 300000; // 5 minutes
        });

        pairedUploads.push({
          original: {
            filename: original.name,
            url: getPublicUrl("original", original.name),
            createdAt: originalCreatedAt,
          },
          staged: matchingStaged
            ? {
                filename: matchingStaged.name,
                url: getPublicUrl("staged", matchingStaged.name),
                createdAt: matchingStaged.created_at || new Date().toISOString(),
              }
            : null,
          createdAt: originalCreatedAt,
        });

        if (matchingStaged) {
          processedStaged.add(matchingStaged.name);
        }
      }

      return {
        uploads: pairedUploads.slice(0, limit),
        total: pairedUploads.length,
      };
    } catch (error) {
      logger(`Error listing recent uploads: ${error}`);
      return { uploads: [], total: 0 };
    }
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: { [key: string]: string } = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".heic": "image/heic",
      ".jfif": "image/jfif",
    };
    return mimeTypes[ext] || "image/jpeg";
  }
}

// Export singleton instance
export const supabaseStorage = new SupabaseStorageService();
