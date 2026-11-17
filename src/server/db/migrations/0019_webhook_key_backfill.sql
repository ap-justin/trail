-- Hand-written: a data backfill, no schema change. A webhook made before 0018 recorded keys takes
-- its bot's key when the bot has exactly one live key; with none or several it stays null and the
-- worker checks it against the bot's live keys. Revoked keys are never recorded.
UPDATE `webhook_subscription` SET `api_key_id` = (
	SELECT `id` FROM `api_key`
	WHERE `actor_id` = `webhook_subscription`.`actor_id` AND `revoked_at` IS NULL
)
WHERE `api_key_id` IS NULL AND (
	SELECT count(*) FROM `api_key`
	WHERE `actor_id` = `webhook_subscription`.`actor_id` AND `revoked_at` IS NULL
) = 1;
