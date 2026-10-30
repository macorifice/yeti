// Starter projects. Each one creates a project in the discovery phase, with its requirements and
// stories open, so the team adapts them instead of starting from an empty page.
import type { Priority } from "./store.js";

export type TemplateRequirement = { title: string; description: string; priority: Priority };
export type TemplateStory = {
  persona: string;
  goal: string;
  benefit: string;
  acceptanceCriteria: string[];
  // Titles of the requirements this story covers
  covers: string[];
};

export type ProjectTemplate = {
  id: string;
  name: string;
  description: string;
  problem: string;
  users: string;
  goal: string;
  requirements: TemplateRequirement[];
  stories: TemplateStory[];
};

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: "marketplace-mvp",
    name: "Local services marketplace (MVP)",
    description: "Providers publish their services, buyers search and request a booking.",
    problem: "Buyers and independent providers of local services cannot find each other reliably.",
    users: "Local service buyers and independent providers",
    goal: "First listings and first bookings within 30 days of launch",
    requirements: [
      { title: "Provider profile", description: "Providers publish services, areas served and availability.", priority: "must" },
      { title: "Search by service and area", description: "Buyers find providers by service category and location.", priority: "must" },
      { title: "Booking request and confirmation", description: "A buyer requests a slot; the provider confirms or declines.", priority: "must" },
      { title: "Reviews after a job", description: "Buyers leave a rating once the job is done.", priority: "should" },
      { title: "Admin moderation", description: "Staff can hide profiles that break the rules.", priority: "could" },
      { title: "Native mobile app", description: "Out of scope for the first release.", priority: "wont" },
    ],
    stories: [
      {
        persona: "provider",
        goal: "publish my services and availability",
        benefit: "buyers can find and book me",
        acceptanceCriteria: ["Services and areas can be edited", "Availability shows the next free slots"],
        covers: ["Provider profile"],
      },
      {
        persona: "buyer",
        goal: "find a provider for a service in my area",
        benefit: "I can choose quickly without calling around",
        acceptanceCriteria: ["Results filter by service and area", "Results show availability"],
        covers: ["Search by service and area"],
      },
      {
        persona: "buyer",
        goal: "request a slot with a provider",
        benefit: "the booking is confirmed without a phone call",
        acceptanceCriteria: ["A request reaches the provider", "The buyer sees confirmed or declined"],
        covers: ["Booking request and confirmation"],
      },
    ],
  },
  {
    id: "customer-portal",
    name: "Customer self-service portal (MVP)",
    description: "Customers check order status and download their documents without calling support.",
    problem: "Customers call support to ask for order status and documents.",
    users: "Customers of a small B2B company and its support staff",
    goal: "Most status and document requests are answered without a call",
    requirements: [
      { title: "Sign-in with an email link", description: "Customers sign in with a one-time link, without a password.", priority: "must" },
      { title: "Order status page", description: "Customers see the status and the expected date of each order.", priority: "must" },
      { title: "Document download", description: "Customers download invoices and contracts for their orders.", priority: "must" },
      { title: "Status notifications", description: "Customers are told by email when an order changes status.", priority: "should" },
      { title: "Messages to support", description: "Customers write to support from the portal.", priority: "could" },
      { title: "Native mobile app", description: "Out of scope for the first release.", priority: "wont" },
    ],
    stories: [
      {
        persona: "customer",
        goal: "sign in with a link sent to my email",
        benefit: "I do not need to remember another password",
        acceptanceCriteria: ["The link works once", "The link expires after 15 minutes"],
        covers: ["Sign-in with an email link"],
      },
      {
        persona: "customer",
        goal: "see the status of my orders",
        benefit: "I do not need to call support to ask",
        acceptanceCriteria: ["Each order shows its status and expected date", "Orders are listed newest first"],
        covers: ["Order status page"],
      },
      {
        persona: "customer",
        goal: "download invoices and contracts",
        benefit: "I can share them with my accounting team",
        acceptanceCriteria: ["Documents download as PDF", "Only my own documents are visible"],
        covers: ["Document download"],
      },
    ],
  },
];
