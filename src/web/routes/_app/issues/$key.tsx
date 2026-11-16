import { createFileRoute, redirect } from "@tanstack/react-router";
import { NotFoundPage } from "@/app/not-found-page";
import { itemParams } from "@/lib/paths";

// the item key's own shape, as the server states it
const itemKey = /^[A-Za-z0-9]{2,10}-[1-9]\d*$/;

/** An item's URL before products: `/issues/TRL-12` is `/products/TRL/12`. */
export const Route = createFileRoute("/_app/issues/$key")({
  beforeLoad: ({ params }) => {
    if (itemKey.test(params.key)) {
      throw redirect({
        to: "/products/$key/$n",
        params: itemParams(params.key),
        replace: true,
      });
    }
  },
  component: NotFoundPage,
});
