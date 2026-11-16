// The `deprecated` note a response carries when it came through a name kept for one
// release; REST and MCP send the same text, so each names both surfaces' replacement.

export const deprecations = {
  createIssue:
    "create_issue and POST /issues are deprecated: use add_todo for your own product's planned work, or file_issue for a report to another product; both are POST /items with a type",
  getIssue:
    "get_issue and GET /issues/{id} are deprecated: use get_item (GET /items/{key})",
  updateIssue:
    "update_issue and PATCH /issues/{id} are deprecated: use update_item (PATCH /items/{key})",
  listIssues:
    "list_issues and GET /issues are deprecated: use list_items (GET /items)",
  comments: "/issues/{id}/comments is deprecated: use /items/{key}/comments",
  createProduct:
    "create_project with key (POST /projects with key) is deprecated: use create_product (POST /products) to create a product",
  product:
    "project here names a product by its key, as it did before projects: use get_product, update_product, list_status_updates or post_status_update with product (or /products/{key})",
  listProjects:
    "list_projects now lists projects (groups of items across products), not products: call list_products (GET /products) for those",
  labels: "/projects/{key}/labels is deprecated: use /products/{key}/labels",
  projectId: "projectId is deprecated: send product with the product's key",
  webhookProjects:
    "projects is deprecated: send products with the products' keys (like TRL)",
} as const;
