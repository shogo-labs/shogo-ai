-- Rename the platform feature flag key for the (formerly) "Shogo Mode" voice
-- translator overlay to "EZ Mode". The row may not exist (overrides default to
-- absent), so this is a no-op when there is nothing to rename.
UPDATE "platform_settings"
  SET "key" = 'feature.ez_mode'
  WHERE "key" = 'feature.shogo_mode';
