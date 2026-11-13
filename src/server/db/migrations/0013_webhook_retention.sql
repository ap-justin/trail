CREATE INDEX `webhook_delivery_pending_age_idx` ON `webhook_delivery` (`subscription_id`,`created_at`) WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX `webhook_delivery_delivered_idx` ON `webhook_delivery` (`delivered_at`) WHERE "status" = 'delivered';--> statement-breakpoint
CREATE INDEX `webhook_delivery_failed_idx` ON `webhook_delivery` (`created_at`) WHERE "status" = 'failed';--> statement-breakpoint
-- a delivered row is never sent again, so its body is dead weight
UPDATE `webhook_delivery` SET `body` = NULL WHERE `status` = 'delivered';