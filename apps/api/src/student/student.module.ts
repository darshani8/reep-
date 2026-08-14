import { Module } from '@nestjs/common';

import { StudentController } from './student.controller';
import { StudentService } from './student.service';
import { CertificationsService } from './certifications.service';
import { ProfileService } from './profile.service';
import { AcademicsService } from './academics.service';

@Module({
  controllers: [StudentController],
  providers: [StudentService, CertificationsService, ProfileService, AcademicsService],
})
export class StudentModule {}
