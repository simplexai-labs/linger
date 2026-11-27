import { defineMessages } from "@/i18n/messages";

/** The Wiki pages: the Profile and Wiki tabs, collections and sidebar trees. */
export const wikiMessages = defineMessages("wiki", {
  // The Wiki home: its two tabs and the overview of generated pages.
  title: "Wiki",
  views: "Wiki views",
  profileTab: "Profile",
  loadingProfile: "Loading Profile…",
  backToWiki: "Back to Wiki",
  viewAll: "View all",
  pagesUnavailable: "Pages are unavailable.",
  dailyReport: "Daily report",
  loadingReports: "Loading reports…",
  reportsUnavailable: "Reports are unavailable.",
  noDailyReports: "No daily reports yet.",
  noProjects: "No projects yet.",
  noTopics: "No topics yet.",
  noPeople: "No people yet.",
  noCompanies: "No companies yet.",
  edited: "Edited {date}",

  // Collections and the directory beside an opened page.
  timeline: "Timeline",
  projects: "Projects",
  topics: "Topics",
  people: "People",
  companies: "Companies",
  loadingTimeline: "Loading timeline…",
  collectionUnavailable: "Wiki collection unavailable.",
  projectCount: { one: "{count} project", other: "{count} projects" },
  topicCount: { one: "{count} topic", other: "{count} topics" },
  peopleCount: { one: "{count} person", other: "{count} people" },
  companyCount: { one: "{count} company", other: "{count} companies" },
  searchProjects: "Search projects",
  searchTopics: "Search topics",
  searchPeople: "Search people",
  searchCompanies: "Search companies",
  noProjectsMatch: "No projects match “{query}”.",
  noTopicsMatch: "No topics match “{query}”.",
  noPeopleMatch: "No people match “{query}”.",
  noCompaniesMatch: "No companies match “{query}”.",
  noGeneratedProjects: "No generated projects yet.",
  noGeneratedTopics: "No generated topics yet.",
  noGeneratedPeople: "No generated people yet.",
  noGeneratedCompanies: "No generated companies yet.",
  projectFiles: "Projects files",
  topicFiles: "Topics files",
  peopleFiles: "People files",
  companyFiles: "Companies files",
  directory: "Wiki directory",
  loadingDocuments: "Loading Wiki Documents…",
  documentsUnavailable: "Wiki Documents are unavailable.",
  retryWiki: "Retry Wiki",
  keep: "Keep",
  keepPage: "Keep {title}",
  deletePage: "Delete {title}",

  // The sidebar trees: generated pages and Meetings.
  pages: "Pages",
  noGeneratedPages: "No generated pages yet.",
  meetingsTree: "Meetings tree",
  expandMeetings: "Expand Meetings",
  collapseMeetings: "Collapse Meetings",
  openMeetings: "Open Meetings",
  loadingMeetings: "Loading Meetings…",
  retryMeetings: "Retry Meetings",
  meetingsUnavailable: "Meetings are unavailable.",
  noMeetings: "No completed meetings yet.",
  meetingsOn: "Meetings on {date}",
  meetingLabel: "Meeting {date} {time}",
  meetingTitle: "Meeting · {date} {time}",
  meetingWhen: "Meeting {when}",

  // Daily and Weekly report cards.
  openTimelineToRead: "Open the timeline to read this report.",
  dailyReportFor: "Daily report {day}",
  weeklyReportFor: "Weekly report {day}",
  openDaily: "Open Daily for {day}",
  openWeekly: "Open Weekly for {day}",
  noDailyReport: "No daily report for this day.",
  noWeeklyReport: "No weekly report for this week.",
  highlights: "Highlights",
  next: "Next",

  // The Profile tab.
  background: "Background",
  communicationStyle: "Communication style",
  workingStyle: "Working style",
  preferences: "Preferences",
  writingStyle: "Writing style",
  profileChanged:
    "Your Profile changed while you were editing, perhaps because Another Me updated it. Cancel to see the latest version, then edit again.",
  retryProfile: "Retry Profile",
  organization: "Organization",
  email: "Email",
  profileDetails: "Profile details",
  updatingProfile: "Another Me is updating your profile",
  profileContent: "Profile content",
  profileSection: "Profile section",
  gettingToKnowYou: "Getting to know you…",
  profileEmpty:
    "Your profile is not available yet. Add a source under Sources to create it.",
  editProfile: "Edit profile",
  editYourProfile: "Edit your profile",
  editProfileForm: "Edit Profile",
  editHint:
    "Keep the five <code>##</code> sections. Under Background, <code>### Timeline</code> lists <code>- years · organization</code> entries with years only (<code>2019</code> start, <code>–2013</code> end or ended by then, <code>Present</code> ongoing); any other <code>###</code> starts a point.",
  profileMarkdown: "Profile Markdown",

  // The Sources row of the Profile infobox.
  sources: "Sources",
  sourcesHint: "Another Me learns from these to write this page",
  profileSources: "Profile sources",
  connectSource: "Connect {app}",
  reconnectSource: "Reconnect {app}",
  connectedSource: "{app} · {account} — connected",
  connectedAccount: "Connected account",
  addSource: "Add source",

  // A refresh that is writing pages, or failed.
  writingWiki: "Another Me is writing your Wiki",
  updateFailed: "Wiki update failed",
  updateFailedComputerOffline:
    "Wiki update failed — Your Computer was offline.",
  updateFailedSignIn: "Wiki update failed — Runtime sign-in required.",
  updateFailedIncompatible:
    "Wiki update failed — Runtime incompatible, or its model isn't available to your account. Update your local CLI or Linger, or check its model setting.",
  updateFailedRuntimeUnavailable:
    "Wiki update failed — Local Runtime is unavailable.",

  // A page the running refresh has written but not published.
  notWrittenYet: "This page is not written yet.",
  notPublished: "This page was not published.",
  notPublishedHint: "Not published yet. This page may still change.",
  generating: "Generating",

  // Links between Wiki pages.
  linkNotWikiPage: "This link does not point to an available Wiki page.",
  linkCouldNotOpen:
    "This linked Wiki page could not be opened. It may be unavailable or you may no longer have access. Please try again.",
});
