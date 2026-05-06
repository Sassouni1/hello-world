import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$")({
  beforeLoad: ({ location }) => {
    const search = location.searchStr || "";
    const hash = location.hash ? `#${location.hash}` : "";
    throw redirect({
      href: `/${search}${hash}`,
      replace: true,
      statusCode: 302,
    });
  },
  component: () => null,
});
