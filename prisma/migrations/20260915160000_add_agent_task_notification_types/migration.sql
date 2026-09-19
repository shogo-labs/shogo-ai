-- Agent task lifecycle notifications are persisted in the shared notification table.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'agent_task_started';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'agent_task_completed';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'agent_task_failed';
