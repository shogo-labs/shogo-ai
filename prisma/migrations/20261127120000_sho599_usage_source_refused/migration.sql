-- The provider charged us but the wallet refused the debit. The row keeps the
-- real cost with billedUsd 0 so provider spend is never invisible (SHO-599).
ALTER TYPE "UsageSource" ADD VALUE IF NOT EXISTS 'refused';
