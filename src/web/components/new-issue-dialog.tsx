import { XIcon } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useId,
  useRef,
  useState,
} from "react";
import { ActorBadge } from "@/components/actor";
import { ProductsEmpty } from "@/components/states";
import { KeyText } from "@/components/text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { WebProductRefView } from "@/lib/api-types";

/** What people file: always an issue, never a todo. */
export type NewIssue = {
  /** The product's key. */
  product: string;
  title: string;
  description: string;
};

export type NewIssueDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The products the viewer can file in. */
  products: WebProductRefView[];
  /** The current product's key; the first product when null or not among `products`. */
  defaultProductKey: string | null;
  /** Who the issue will be credited to. */
  viewer: { name: string; isOwner: boolean };
  /** Who to ask for access when `products` is empty. */
  ownerName: string;
  /** Title and description arrive trimmed; the caller navigates to the new issue. */
  onSubmit: (issue: NewIssue) => void;
  pending: boolean;
  /** Why the last create failed, above the buttons; null when it didn't. */
  error: ReactNode;
};

type Errors = { product?: string; title?: string };

/** `webIssueCreateSchema.title` in src/shared/schemas.ts, which src/web can only import as a type. */
const TITLE_MAX = 300;

function titleError(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return "Add a title.";
  if (trimmed.length > TITLE_MAX) return `Keep it to ${TITLE_MAX} characters.`;
  return undefined;
}

function validate(productKey: string | null, title: string): Errors {
  const titleMessage = titleError(title);
  return {
    ...(productKey ? {} : { product: "Pick a product." }),
    ...(titleMessage ? { title: titleMessage } : {}),
  };
}

function NewIssueForm({
  products,
  defaultProductKey,
  viewer,
  onSubmit,
  pending,
  error,
  titleRef,
}: Omit<NewIssueDialogProps, "open" | "onOpenChange" | "ownerName"> & {
  titleRef: RefObject<HTMLInputElement | null>;
}) {
  const [productKey, setProductKey] = useState<string | null>(
    () =>
      products.find((p) => p.key === defaultProductKey)?.key ??
      products[0]?.key ??
      null,
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // null until the first submit; from then on each edit re-checks
  const [errors, setErrors] = useState<Errors | null>(null);
  const productTriggerRef = useRef<HTMLButtonElement>(null);
  const ids = {
    product: useId(),
    title: useId(),
    description: useId(),
    status: useId(),
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const found = validate(productKey, title);
    setErrors(found);
    if (found.product || !productKey) {
      productTriggerRef.current?.focus();
    } else if (found.title) {
      titleRef.current?.focus();
    } else {
      onSubmit({
        product: productKey,
        title: title.trim(),
        description: description.trim(),
      });
    }
  };

  const items = products.map((p) => ({ value: p.key, label: p.name }));

  return (
    <form
      noValidate
      onSubmit={submit}
      className="flex flex-1 flex-col gap-4 px-4 pt-5 pb-4 lg:p-0"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.product} className="w-fit font-medium">
            Product
          </label>
          <Select
            items={items}
            value={productKey}
            onValueChange={(value: string | null) => {
              setProductKey(value);
              if (errors) setErrors(validate(value, title));
            }}
          >
            <SelectTrigger
              id={ids.product}
              ref={productTriggerRef}
              aria-invalid={errors?.product ? true : undefined}
              aria-describedby={
                errors?.product ? `${ids.product}-error` : undefined
              }
              className="w-full data-[size=default]:h-9 max-lg:data-[size=default]:h-10"
            >
              <SelectValue placeholder="Pick a product">
                {(key: string | null) => {
                  const product = products.find((p) => p.key === key);
                  return product ? (
                    <>
                      <KeyText className="text-foreground">
                        {product.key}
                      </KeyText>{" "}
                      {product.name}
                    </>
                  ) : (
                    "Pick a product"
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="start">
              <SelectGroup>
                {products.map((product) => (
                  <SelectItem key={product.key} value={product.key}>
                    <KeyText className="text-foreground">{product.key}</KeyText>{" "}
                    {product.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {errors?.product && (
            <p id={`${ids.product}-error`} className="text-xs text-destructive">
              {errors.product}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.title} className="w-fit font-medium">
            Title
          </label>
          <Input
            id={ids.title}
            ref={titleRef}
            value={title}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setTitle(next);
              if (errors) setErrors(validate(productKey, next));
            }}
            aria-invalid={errors?.title ? true : undefined}
            aria-describedby={errors?.title ? `${ids.title}-error` : undefined}
            className="h-9 max-lg:h-10"
          />
          {errors?.title && (
            <p id={`${ids.title}-error`} className="text-xs text-destructive">
              {errors.title}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.description} className="flex gap-1 font-medium">
            Description
            <span className="font-normal text-muted-foreground">Markdown</span>
          </label>
          <Textarea
            id={ids.description}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
            placeholder="What should the bots know?"
            className="min-h-35 resize-none text-sm max-lg:min-h-45"
          />
        </div>
      </div>
      <p id={ids.status} role="status" className="text-xs text-destructive">
        {error}
      </p>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-2">
        <p className="flex flex-wrap items-center gap-1 text-muted-foreground">
          Filing as{" "}
          <span className="font-medium text-foreground">{viewer.name}</span>
          <ActorBadge kind="human" />
        </p>
        <div className="flex gap-2 lg:ml-auto">
          <DialogClose
            render={
              <Button
                variant="outline"
                className="max-lg:h-11 max-lg:flex-1 lg:px-3"
              />
            }
          >
            Cancel
          </DialogClose>
          <Button
            type="submit"
            aria-disabled={pending || undefined}
            aria-busy={pending || undefined}
            aria-describedby={ids.status}
            className="max-lg:h-11 max-lg:flex-1 lg:px-3"
          >
            {pending ? "Creating…" : "Create issue"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * Filing an issue: a centred dialog at 1024px and up, a full-screen sheet below. Title
 * and product are required; an empty title, or one over 300 characters once trimmed, is
 * caught on submit, focus moves to it, and `onSubmit` is not called. A click outside does
 * not close it, so a draft is never lost to a stray click.
 */
export function NewIssueDialog({
  open,
  onOpenChange,
  ownerName,
  ...form
}: NewIssueDialogProps) {
  const titleRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      disablePointerDismissal
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={titleRef}
        className="flex max-w-none flex-col gap-0 overflow-y-auto p-0 ring-0 sm:max-w-none max-lg:inset-0 max-lg:h-dvh max-lg:translate-none max-lg:rounded-none lg:w-140 lg:gap-4 lg:rounded-2xl lg:border lg:p-5 lg:shadow-xl"
      >
        <div className="flex items-center max-lg:h-12 max-lg:border-b max-lg:pr-2 max-lg:pl-4">
          <DialogTitle className="flex-1 text-base font-medium">
            New issue
          </DialogTitle>
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close"
                className="text-muted-foreground max-lg:size-10"
              />
            }
          >
            <XIcon aria-hidden="true" />
          </DialogClose>
        </div>
        {form.products.length === 0 ? (
          // nowhere to file yet: the Products page's empty state, not a form that can't submit
          <ProductsEmpty ownerName={ownerName} isOwner={form.viewer.isOwner} />
        ) : (
          // the popup unmounts on close, so each opening starts from a fresh form
          <NewIssueForm {...form} titleRef={titleRef} />
        )}
      </DialogContent>
    </Dialog>
  );
}
