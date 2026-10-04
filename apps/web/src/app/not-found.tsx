import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="grid min-h-[50vh] place-items-center text-center">
      <div>
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <Link href="/" className={`${buttonVariants({ variant: "secondary" })} mt-4`}>
          Home
        </Link>
      </div>
    </div>
  );
}
