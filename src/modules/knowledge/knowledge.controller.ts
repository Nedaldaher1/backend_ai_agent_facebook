import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Knowledge')
@Controller('knowledge')
export class KnowledgeController {}
