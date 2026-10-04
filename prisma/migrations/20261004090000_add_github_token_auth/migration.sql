-- CreateEnum
CREATE TYPE "GitHubAuthType" AS ENUM ('app', 'token');

-- AlterTable
ALTER TABLE "github_connections" ADD COLUMN     "authType" "GitHubAuthType" NOT NULL DEFAULT 'app',
ADD COLUMN     "encryptedToken" TEXT,
ADD COLUMN     "tokenLogin" TEXT;

