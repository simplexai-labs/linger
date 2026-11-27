-- +goose Up
-- Agent templates are gone: the starter Agents are defined in code, and no
-- Agent is created from a template or installs template Routines any more.
-- Routines already copied into Rooms keep their template origin columns on
-- room_reminders, which listener Routines share.
ALTER TABLE public.agent_registrations
    DROP CONSTRAINT agent_registrations_template_routines_check,
    DROP CONSTRAINT agent_registrations_template_shape,
    DROP COLUMN template_id,
    DROP COLUMN template_routines,
    DROP COLUMN template_installed_at;

DROP TABLE public.agent_templates;

-- +goose Down
CREATE TABLE public.agent_templates (
    template_id text NOT NULL,
    origin text NOT NULL,
    tenant_id text,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    instructions text NOT NULL,
    avatar_key text,
    skill_bindings jsonb DEFAULT '[]'::jsonb NOT NULL,
    published_by_actor_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    connector_bindings jsonb DEFAULT '[]'::jsonb NOT NULL,
    routines jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT agent_templates_avatar_key_check CHECK (((avatar_key IS NULL) OR ((length(avatar_key) >= 1) AND (length(avatar_key) <= 64)))),
    CONSTRAINT agent_templates_check CHECK ((((origin = 'builtin'::text) AND (tenant_id IS NULL) AND (published_by_actor_id IS NULL)) OR ((origin = 'published'::text) AND (tenant_id IS NOT NULL) AND (published_by_actor_id IS NOT NULL)))),
    CONSTRAINT agent_templates_connector_bindings_check CHECK (((jsonb_typeof(connector_bindings) = 'array'::text) AND (jsonb_array_length(connector_bindings) <= 20))),
    CONSTRAINT agent_templates_description_check CHECK ((length(description) <= 1000)),
    CONSTRAINT agent_templates_instructions_check CHECK (((length(instructions) >= 1) AND (length(instructions) <= 50000))),
    CONSTRAINT agent_templates_name_check CHECK (((length(name) >= 1) AND (length(name) <= 120))),
    CONSTRAINT agent_templates_origin_check CHECK ((origin = ANY (ARRAY['builtin'::text, 'published'::text]))),
    CONSTRAINT agent_templates_routines_check CHECK (((jsonb_typeof(routines) = 'array'::text) AND (jsonb_array_length(routines) <= 50))),
    CONSTRAINT agent_templates_skill_bindings_check CHECK ((jsonb_typeof(skill_bindings) = 'array'::text)),
    CONSTRAINT agent_templates_template_id_check CHECK (((length(template_id) >= 1) AND (length(template_id) <= 64) AND (template_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'::text))),
    CONSTRAINT agent_templates_pkey PRIMARY KEY (template_id),
    CONSTRAINT agent_templates_published_by_actor_id_fkey FOREIGN KEY (published_by_actor_id) REFERENCES public.actors(id)
);

CREATE INDEX agent_templates_listing_idx ON public.agent_templates USING btree (origin, created_at DESC);

CREATE INDEX agent_templates_publisher_idx ON public.agent_templates USING btree (published_by_actor_id);

ALTER TABLE public.agent_registrations
    ADD COLUMN template_id text,
    ADD COLUMN template_routines jsonb,
    ADD COLUMN template_installed_at timestamp with time zone,
    ADD CONSTRAINT agent_registrations_template_routines_check CHECK (((jsonb_typeof(template_routines) = 'array'::text) AND (jsonb_array_length(template_routines) <= 50))),
    ADD CONSTRAINT agent_registrations_template_shape CHECK ((((template_id IS NULL) = (template_routines IS NULL)) AND ((template_installed_at IS NULL) OR (template_id IS NOT NULL))));
