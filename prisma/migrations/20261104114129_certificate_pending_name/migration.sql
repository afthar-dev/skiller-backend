-- CreateEnum
CREATE TYPE "CertificateState" AS ENUM ('PENDING_NAME', 'VALID');

-- AlterTable
ALTER TABLE "certificates" ADD COLUMN     "state" "CertificateState" NOT NULL DEFAULT 'VALID',
ALTER COLUMN "learnerName" DROP NOT NULL,
ALTER COLUMN "objectKey" DROP NOT NULL;
