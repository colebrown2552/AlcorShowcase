<?php
/**
 * Plugin Name: Alcor Demo Fixtures
 * Description: Demo only. Registers two sample AlcorFields documents, two service-to-service REST routes and a sitemap route so the demo script has something to call. Do not install on a real site.
 * Version: 1.0.0
 * Author: Alcor Industries
 *
 * The production plugins in mu-plugins/ only provide mechanisms: AlcorFields needs a page template and a theme that
 * renders it, and alcor_s2s_verify() needs a route that calls it. This file supplies the smallest versions of those
 * so the demo can exercise the real code over HTTP. It is inert unless the demo script has written its per-run
 * settings file, so copying it somewhere by mistake does nothing.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Where the demo script mounts its per-run state directory inside WordPress's file system.
 */
const ALCOR_DEMO_STATE_DIR = '/alcor-demo-state';

/**
 * Reads the per-run settings (passwords and keys) that the demo script generated.
 *
 * @return array<string, string>|null The settings, or null when the file is missing or unreadable.
 */
function alcor_demo_config() {
	$file = ALCOR_DEMO_STATE_DIR . '/config.json';
	if ( ! is_readable( $file ) ) {
		return null;
	}
	$config = json_decode( (string) file_get_contents( $file ), true );
	return is_array( $config ) ? $config : null;
}

$alcor_demo_settings = alcor_demo_config();
if ( null === $alcor_demo_settings || ! function_exists( 'alcor_s2s_verify' ) || ! function_exists( 'alcor_fields_register_document' ) ) {
	return;
}

// The signing key for the demo routes, and the explicit opt-in to plain HTTP on loopback that alcor-s2s-auth.php
// requires. Both exist only for this run.
if ( ! defined( 'ALCOR_DEMO_ORDERS_KEY' ) ) {
	define( 'ALCOR_DEMO_ORDERS_KEY', (string) $alcor_demo_settings['s2s_key'] );
}
if ( ! defined( 'ALCOR_S2S_LOCAL_QA' ) ) {
	define( 'ALCOR_S2S_LOCAL_QA', true );
}

/**
 * Registers two AlcorFields documents that share one template. A client editor is assigned only the first, which
 * lets the demo show that access is decided per document.
 *
 * @return void
 */
function alcor_demo_register_documents() {
	$template = __DIR__ . '/landing.html';
	foreach ( array(
		'demo-landing' => 'Demo landing page',
		'demo-private' => 'Private demo page',
	) as $key => $label ) {
		alcor_fields_register_document(
			$key,
			array(
				'label'    => $label,
				'group'    => 'Demo',
				'template' => $template,
				'view_url' => home_url( '/alcor-demo/' ),
			)
		);
	}
}
add_action( 'alcor_fields_register', 'alcor_demo_register_documents' );

/**
 * Serves the demo-landing document at /alcor-demo/ the way a theme would: render, print, stop.
 *
 * @return void
 */
function alcor_demo_serve_landing() {
	$uri = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- only compared with a fixed string.
	if ( '/alcor-demo/' !== wp_parse_url( (string) $uri, PHP_URL_PATH ) ) {
		return;
	}
	status_header( 200 );
	header( 'Content-Type: text/html; charset=utf-8' );
	echo alcor_fields_render_document( 'demo-landing' ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- AlcorFields validates stored values and escapes on render.
	exit;
}
add_action( 'template_redirect', 'alcor_demo_serve_landing', 1 );

/**
 * Lists /alcor-demo/ in the routes sitemap (alcor-public-sitemap.php).
 *
 * @param string[] $paths Routes registered so far.
 * @return string[]
 */
function alcor_demo_public_routes( $paths ) {
	$paths[] = '/alcor-demo/';
	return $paths;
}
add_filter( 'alcor_public_routes', 'alcor_demo_public_routes' );

/**
 * Registers the REST routes that are guarded by alcor_s2s_verify().
 *
 * /orders accepts a signed POST. /status is a signed GET, which shows that the query string is bound into the
 * signature. /unconfigured names a key constant that is never defined, which shows the fail-closed 404.
 *
 * @return void
 */
function alcor_demo_register_routes() {
	register_rest_route(
		'alcor-demo/v1',
		'/orders',
		array(
			'methods'             => 'POST',
			'callback'            => static function ( WP_REST_Request $request ) {
				return rest_ensure_response(
					array(
						'accepted'    => true,
						'body_sha256' => hash( 'sha256', $request->get_body() ),
					)
				);
			},
			'permission_callback' => static function ( WP_REST_Request $request ) {
				return alcor_s2s_verify( $request, 'ALCOR_DEMO_ORDERS_KEY' );
			},
		)
	);
	register_rest_route(
		'alcor-demo/v1',
		'/status',
		array(
			'methods'             => 'GET',
			'callback'            => static function ( WP_REST_Request $request ) {
				return rest_ensure_response( array( 'region' => (string) $request->get_param( 'region' ) ) );
			},
			'permission_callback' => static function ( WP_REST_Request $request ) {
				return alcor_s2s_verify( $request, 'ALCOR_DEMO_ORDERS_KEY' );
			},
		)
	);
	register_rest_route(
		'alcor-demo/v1',
		'/unconfigured',
		array(
			'methods'             => 'POST',
			'callback'            => static function () {
				return rest_ensure_response( array( 'accepted' => true ) );
			},
			'permission_callback' => static function ( WP_REST_Request $request ) {
				return alcor_s2s_verify( $request, 'ALCOR_DEMO_UNSET_KEY' );
			},
		)
	);
}
add_action( 'rest_api_init', 'alcor_demo_register_routes' );
