import { Module } from '@nestjs/common';

import { StudentController } from './student.controller';
import { StudentService } from './student.service';
import { CertificationsService } from './certifications.service';
import { ProfileService } from './profile.service';

@Module({
  controllers: [StudentController],
  providers: [StudentService, CertificationsService, ProfileService],
})
export class StudentModule {}
