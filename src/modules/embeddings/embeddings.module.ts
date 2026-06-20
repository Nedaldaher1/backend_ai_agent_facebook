import { Module } from '@nestjs/common';
import { EmbeddingService } from './embedding.service';

/**
 * Pure inference infrastructure: owns model loading + the embedding API and
 * nothing else (no database, no feature-module imports). ConfigService is global
 * (AppConfigModule), so no ConfigModule import is needed. Feature modules that
 * need embeddings import this module and use the exported EmbeddingService.
 */
@Module({
  providers: [EmbeddingService],
  exports: [EmbeddingService],
})
export class EmbeddingsModule {}
