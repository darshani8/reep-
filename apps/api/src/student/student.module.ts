import { Module } from '@nestjs/common';

import { StudentController } from './student.controller';
import { StudentService } from './student.service';
import { CertificationsService } from './certifications.service';

@Module({
  controllers: [StudentController],
  providers: [StudentService, CertificationsService],
})
export class StudentModule {}
