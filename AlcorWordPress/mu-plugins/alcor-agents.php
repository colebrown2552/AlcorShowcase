<?php
/**
 * Plugin Name: Alcor Agents
 * Description: A site for AI agents: a machine-readable catalog at /agents.json, an OpenAPI 3.1 description of the quote endpoint at /openapi.json (also /.well-known/openapi.json), and robots.txt rules that name the main AI crawlers.
 * Version: 1.0.0
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * Author: Alcor Industries
 *
 * An AI agent that works for a person or a business needs to know what the site offers and how to ask for it
 * without parsing marketing pages. This plugin publishes that as data: what the site sells, the etiquette it
 * expects from an agent, and an OpenAPI description of the one write endpoint (a request for a written quote).
 *
 * It only describes the endpoint; it adds no new way to write data. The endpoint is whatever route the site already
 * has for contact requests. Point the description at it with the alcor_agents_quote_path filter. Contact details come
 * from wp-config.php:
 *
 *     define( 'ALCOR_AGENTS_CONTACT_EMAIL', 'agents@example.com' );
 *
 * Replace the service list with the alcor_agents_services filter. No prices are published; every job gets a
 * written quote.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Returns the REST path of the site's quote-request endpoint.
 *
 * @return string A site-relative path such as "/wp-json/alcor-agents/v1/quote".
 */
function alcor_agents_quote_path() {
	/**
	 * Filters the path of the endpoint the catalog and the OpenAPI document describe.
	 *
	 * @param string $path Site-relative path, starting with a slash.
	 */
	return (string) apply_filters( 'alcor_agents_quote_path', '/wp-json/alcor-agents/v1/quote' );
}

/**
 * Returns the full URL of the quote-request endpoint.
 *
 * @return string
 */
function alcor_agents_quote_url() {
	return home_url( alcor_agents_quote_path() );
}

/**
 * Returns the address agents should write to when they want a person.
 *
 * @return string The ALCOR_AGENTS_CONTACT_EMAIL constant when it holds a valid address; otherwise a placeholder.
 */
function alcor_agents_contact_email() {
	$email = defined( 'ALCOR_AGENTS_CONTACT_EMAIL' ) ? (string) ALCOR_AGENTS_CONTACT_EMAIL : '';
	return is_email( $email ) ? $email : 'agents@example.com';
}

/**
 * Lists the services an agent can ask for on behalf of the person or business it works for. A written quote comes first.
 *
 * @return array<int, array{id: string, name: string, url: string, description: string}>
 */
function alcor_agents_services() {
	$services = array(
		array(
			'id'          => 'landing-page',
			'name'        => 'Landing page',
			'url'         => home_url( '/' ),
			'description' => 'One custom page for an offer or launch, designed to get calls or form fills, with analytics set up.',
		),
		array(
			'id'          => 'custom-plugin',
			'name'        => 'Custom WordPress plugin',
			'url'         => home_url( '/' ),
			'description' => 'A WordPress plugin written for one job: an admin screen, a form, or a connection to software the business already uses.',
		),
		array(
			'id'          => 'agent-ready',
			'name'        => 'Agent-ready website work',
			'url'         => home_url( '/' ),
			'description' => 'Make a WordPress site usable by AI agents: schema.org data, and an agent-callable quote, booking or order API like the one described here. Built as custom plugin work.',
		),
		array(
			'id'          => 'mcp-server',
			'name'        => 'MCP server or tool API for a business',
			'url'         => home_url( '/' ),
			'description' => 'A Model Context Protocol server or JSON API so assistants can check stock, quote, or book with the business directly. Built as custom plugin work.',
		),
		array(
			'id'          => 'store',
			'name'        => 'Online store',
			'url'         => home_url( '/' ),
			'description' => 'Product pages and checkout, built into a WordPress site.',
		),
	);
	/**
	 * Filters the services listed in the agent catalog.
	 *
	 * @param array $services Each service has id, name, url and description.
	 */
	return (array) apply_filters( 'alcor_agents_services', $services );
}

/**
 * Builds the agent catalog served at /agents.json.
 *
 * @return array JSON-ready catalog.
 */
function alcor_agents_catalog() {
	return array(
		'schema_version'  => '1.0',
		'name'            => get_bloginfo( 'name' ),
		'url'             => home_url( '/' ),
		'description'     => get_bloginfo( 'description' ),
		'contact'         => array( 'email' => alcor_agents_contact_email() ),
		'how_buying_works' => array(
			'Send a quote request with the quote API below, or email us.',
			'A person reads it and replies by email to the address in the request.',
			'A written quote with the exact price comes before any work starts. Nothing is charged through the API.',
		),
		'agent_rules'     => array(
			'Send a request only when the person or business you act for has asked you to.',
			'Use their name and an email address they read; the reply goes there.',
			'Say you are an AI agent and whom you act for in the message.',
			'Reuse the same submission_id when retrying the same request; it is saved once.',
		),
		'quote_api'       => array(
			'method'             => 'POST',
			'url'                => alcor_agents_quote_url(),
			'content_type'       => 'application/json',
			'openapi'            => home_url( '/openapi.json' ),
			'required'           => array( 'name', 'email', 'message' ),
			'optional'           => array( 'company', 'role_title', 'current_process', 'desired_outcome', 'timeline', 'budget_band', 'submission_id' ),
			'timeline_values'    => array( 'exploring', '30-days', '1-3-months', '3-plus-months', 'unsure' ),
			'budget_band_values' => array( 'under-1k', '1k-5k', '5k-10k', '10k-plus' ),
			'example'            => array(
				'name'          => 'Dana Ortiz',
				'email'         => 'dana@example.com',
				'company'       => 'Ortiz Pottery',
				'message'       => 'I am an AI assistant writing for Dana Ortiz. She would like a landing page for her pottery studio.',
				'timeline'      => '30-days',
				'submission_id' => '6f1c2b3a-9d4e-4f5a-8b6c-7d8e9f0a1b2c',
			),
		),
		'services'        => alcor_agents_services(),
		'more'            => array( 'openapi' => home_url( '/openapi.json' ) ),
	);
}

/**
 * Builds the OpenAPI 3.1 description of the quote endpoint, served at /openapi.json.
 *
 * @return array JSON-ready OpenAPI document.
 */
function alcor_agents_openapi() {
	$str = array( 'type' => 'string' );
	return array(
		'openapi' => '3.1.0',
		'info'    => array(
			'title'       => get_bloginfo( 'name' ) . ' quote API',
			'version'     => '1.0.0',
			'description' => 'Ask for a written quote on behalf of a person or business. A person reads every request and replies by email. Nothing is charged through this API.',
			'contact'     => array(
				'email' => alcor_agents_contact_email(),
				'url'   => home_url( '/' ),
			),
		),
		'servers' => array( array( 'url' => untrailingslashit( home_url( '/' ) ) ) ),
		'paths'   => array(
			alcor_agents_quote_path() => array(
				'post' => array(
					'operationId' => 'requestQuote',
					'summary'     => 'Request a written quote',
					'description' => 'Send only when the person you act for asked you to. Include who you are acting for in the message. Retrying with the same submission_id never saves a request twice.',
					'requestBody' => array(
						'required' => true,
						'content'  => array(
							'application/json' => array(
								'schema' => array(
									'type'       => 'object',
									'required'   => array( 'name', 'email', 'message' ),
									'properties' => array(
										'name'            => $str + array(
											'maxLength'   => 120,
											'description' => 'The person the site or tool is for.',
										),
										'email'           => $str + array(
											'format'      => 'email',
											'description' => 'Where the reply goes. Must be an inbox the person reads.',
										),
										'message'         => $str + array(
											'minLength'   => 5,
											'maxLength'   => 4000,
											'description' => 'What should be built, and that you are an AI agent acting for this person.',
										),
										'company'         => $str + array( 'maxLength' => 160 ),
										'role_title'      => $str + array( 'maxLength' => 160 ),
										'current_process' => $str + array(
											'maxLength'   => 4000,
											'description' => 'How the job is handled today.',
										),
										'desired_outcome' => $str + array(
											'maxLength'   => 4000,
											'description' => 'What should be different when it is done.',
										),
										'timeline'        => $str + array( 'enum' => array( 'exploring', '30-days', '1-3-months', '3-plus-months', 'unsure' ) ),
										'budget_band'     => $str + array( 'enum' => array( 'under-1k', '1k-5k', '5k-10k', '10k-plus' ) ),
										'submission_id'   => $str + array(
											'format'      => 'uuid',
											'description' => 'A UUID v4 you generate once per request and reuse on retries.',
										),
									),
								),
							),
						),
					),
					'responses'   => array(
						'200' => array(
							'description' => 'Received. A person will reply by email.',
							'content'     => array(
								'application/json' => array(
									'schema' => array(
										'type'       => 'object',
										'properties' => array(
											'ok'             => array( 'type' => 'boolean' ),
											'opportunity_id' => $str,
										),
									),
								),
							),
						),
						'400' => array( 'description' => 'Missing name, a valid email, or a message.' ),
						'409' => array( 'description' => 'This submission_id was already used with different details. Generate a new one.' ),
						'503' => array( 'description' => 'Temporarily unavailable. Retry later with the same submission_id.' ),
					),
				),
			),
			'/agents.json'            => array(
				'get' => array(
					'operationId' => 'getCatalog',
					'summary'     => 'Services, contact and the rules for agents',
					'responses'   => array(
						'200' => array(
							'description' => 'The catalog.',
							'content'     => array( 'application/json' => array( 'schema' => array( 'type' => 'object' ) ) ),
						),
					),
				),
			),
		),
	);
}

/**
 * Returns the path part of the current request.
 *
 * @return string Request path such as "/agents.json", or "/" when there is none.
 */
function alcor_agents_path() {
	$uri = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : '/'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- only compared with fixed strings.
	return (string) wp_parse_url( (string) $uri, PHP_URL_PATH );
}

/**
 * Serves the machine-readable files.
 *
 * The files are public, read-only data with no cookies or credentials involved, so the open CORS header is safe and
 * lets an agent running in a browser fetch them. Runs at priority 0 on template_redirect, before WordPress decides
 * that the path is a 404.
 *
 * @return void
 */
function alcor_agents_serve() {
	$docs = array(
		'/agents.json'              => 'alcor_agents_catalog',
		'/openapi.json'             => 'alcor_agents_openapi',
		'/.well-known/openapi.json' => 'alcor_agents_openapi',
	);
	$path = alcor_agents_path();
	if ( ! isset( $docs[ $path ] ) ) {
		return;
	}
	status_header( 200 );
	header( 'Content-Type: application/json; charset=utf-8' );
	header( 'Access-Control-Allow-Origin: *' );
	header( 'X-Content-Type-Options: nosniff' );
	header( 'Cache-Control: public, max-age=3600' );
	echo wp_json_encode( call_user_func( $docs[ $path ] ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- JSON, not HTML.
	exit;
}
add_action( 'template_redirect', 'alcor_agents_serve', 0 );

/**
 * Names the main AI crawlers in robots.txt and points them at the agent files.
 *
 * A crawler that finds a group addressed to it ignores the "User-agent: *" group, so the wp-admin rule is repeated in
 * each named group. Nothing is added when the site asks search engines to stay away (Settings > Reading).
 *
 * @param string     $output Robots.txt content so far.
 * @param bool|string $public Whether the site is public.
 * @return string The content, with the AI crawler groups appended.
 */
function alcor_agents_robots_txt( $output, $public ) {
	if ( ! $public ) {
		return $output;
	}
	$bots  = array(
		'GPTBot',
		'OAI-SearchBot',
		'ChatGPT-User',
		'ClaudeBot',
		'Claude-User',
		'Claude-SearchBot',
		'anthropic-ai',
		'PerplexityBot',
		'Perplexity-User',
		'Google-Extended',
		'Applebot-Extended',
		'CCBot',
		'Amazonbot',
		'meta-externalagent',
		'DuckAssistBot',
		'MistralAI-User',
	);
	$lines = "\n# AI agents and assistants are welcome. Start at /agents.json.\n";
	foreach ( $bots as $bot ) {
		$lines .= "User-agent: {$bot}\nAllow: /\nDisallow: /wp-admin/\n\n";
	}
	$lines .= '# Agent catalog: ' . home_url( '/agents.json' ) . "\n# Quote API (OpenAPI): " . home_url( '/openapi.json' ) . "\n";
	return $output . $lines;
}
add_filter( 'robots_txt', 'alcor_agents_robots_txt', 20, 2 );
