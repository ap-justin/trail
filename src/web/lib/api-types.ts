// The server's view types, re-exported type-only so components share one import path.
// (biome's server-import rule reads a type import that wraps onto several lines as a value import.)
export type {
  EntryView,
  FeedView,
  MeView,
  PeopleView,
  PersonView,
  SearchView,
  WebActorView,
  WebItemListView,
  WebItemRefView,
  WebItemRowView,
  WebItemType,
  WebItemView,
  WebProductDetailView,
  WebProductListView,
  WebProductRefView,
  WebProductView,
  WebProjectRefView,
  WebStatusUpdatePageView,
  WebStatusUpdateView,
} from "../../shared/schemas";
