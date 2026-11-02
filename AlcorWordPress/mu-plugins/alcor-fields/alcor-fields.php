<?php
/**
 * Plugin Name: AlcorFields
 * Description: Client-editable page content declared by data-af-* annotations in the page template: typed validation, drafts, preview, history, REST and JSON hand-off. No dependencies.
 * Version: 1.0.0
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * Author: Alcor Industries
 *
 * Runs as a must-use plugin (the loader file next to this folder requires it) or as an ordinary plugin when this
 * folder is copied into wp-content/plugins/. Documents are registered by code (alcor_fields_register_document() on
 * the alcor_fields_register action); there is no screen for adding templates, so an editor can change words, links,
 * images, list items and optional sections, never markup or code.
 *
 * Reading order: class-alcor-fields-html.php (strict parser), -types.php (the five field types), -template.php
 * (annotations to schema, validation, rendering), -store.php (versioned storage), -access.php (who may edit what),
 * -rest.php (the REST API), -admin.php (the wp-admin screens).
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
if ( defined( 'ALCOR_FIELDS_VERSION' ) ) {
	return;
}
define( 'ALCOR_FIELDS_VERSION', '1.0.0' );
define( 'ALCOR_FIELDS_DIR', __DIR__ );

require_once __DIR__ . '/src/class-alcor-fields-error.php';
require_once __DIR__ . '/src/class-alcor-fields-node.php';
require_once __DIR__ . '/src/class-alcor-fields-html.php';
require_once __DIR__ . '/src/class-alcor-fields-types.php';
require_once __DIR__ . '/src/class-alcor-fields-template.php';
require_once __DIR__ . '/src/class-alcor-fields-conflict.php';
require_once __DIR__ . '/src/class-alcor-fields-store.php';
require_once __DIR__ . '/src/class-alcor-fields-access.php';
require_once __DIR__ . '/src/class-alcor-fields-admin.php';
require_once __DIR__ . '/src/class-alcor-fields-rest.php';

/* ---------------------------------------------------------------------- registry */

/**
 * Registers a client-editable document.
 *
 * @param string $key  [a-z0-9-]{1,64}, stable forever: stored content and exports are keyed by it.
 * @param array  $args {
 *     Document settings.
 *
 *     @type string $label          Name shown to editors.
 *     @type string $template       Absolute path to the annotated HTML file.
 *     @type string $group          Heading that groups documents in the list.
 *     @type string $view_url       Public URL of the rendered page.
 *     @type string $asset_base_url URL that the template's relative image paths resolve against, for editor previews.
 *     @type string $description    Longer description.
 * }
 * @return bool True when registered; false (with a developer notice) when the key or template is unusable.
 */
function alcor_fields_register_document( $key, array $args ) {
	if ( ! is_string( $key ) || ! preg_match( '/^[a-z0-9][a-z0-9-]{0,63}$/', $key ) ) {
		_doing_it_wrong( __FUNCTION__, 'AlcorFields document keys are lowercase letters, digits and hyphens.', ALCOR_FIELDS_VERSION );
		return false;
	}
	$template = isset( $args['template'] ) ? (string) $args['template'] : '';
	if ( '' === $template || ! is_file( $template ) ) {
		_doing_it_wrong( __FUNCTION__, 'AlcorFields document ' . esc_html( $key ) . ' needs an existing template file.', ALCOR_FIELDS_VERSION );
		return false;
	}
	$GLOBALS['alcor_fields_documents'][ $key ] = array(
		'key'            => $key,
		'label'          => (string) ( $args['label'] ?? $key ),
		'group'          => (string) ( $args['group'] ?? '' ),
		'description'    => (string) ( $args['description'] ?? '' ),
		'template'       => $template,
		'view_url'       => (string) ( $args['view_url'] ?? '' ),
		'asset_base_url' => (string) ( $args['asset_base_url'] ?? '' ),
	);
	return true;
}

/**
 * Returns every registered document, sorted by group and then label.
 *
 * The alcor_fields_register action fires on the first call after init, so documents can be registered by any
 * plugin or theme that hooks it, regardless of load order.
 *
 * @return array<string, array> Documents keyed by document key.
 */
function alcor_fields_documents() {
	static $fired = false;
	if ( ! $fired && did_action( 'init' ) ) {
		$fired = true;
		$GLOBALS['alcor_fields_documents'] = $GLOBALS['alcor_fields_documents'] ?? array();
		do_action( 'alcor_fields_register' );
		uasort(
			$GLOBALS['alcor_fields_documents'],
			static function ( $a, $b ) {
				return array( $a['group'], $a['label'] ) <=> array( $b['group'], $b['label'] );
			}
		);
	}
	return $GLOBALS['alcor_fields_documents'] ?? array();
}

/**
 * Returns one registered document.
 *
 * @param mixed $key Document key.
 * @return array|null The document, or null when there is no such key.
 */
function alcor_fields_document( $key ) {
	$docs = alcor_fields_documents();
	return is_string( $key ) && isset( $docs[ $key ] ) ? $docs[ $key ] : null;
}

/**
 * Returns the compiled template of a document, cached per request and keyed by the file's modification time.
 *
 * @param string $key Document key.
 * @return Alcor_Fields_Template
 * @throws Alcor_Fields_Error When there is no such document or its template is invalid.
 */
function alcor_fields_template( $key ) {
	static $cache = array();
	$doc          = alcor_fields_document( $key );
	if ( ! $doc ) {
		throw Alcor_Fields_Error::at( $key, 'no such document' );
	}
	$id = $doc['template'] . '@' . (int) filemtime( $doc['template'] );
	if ( ! isset( $cache[ $id ] ) ) {
		$cache[ $id ] = Alcor_Fields_Template::from_file( $doc['template'] );
	}
	return $cache[ $id ];
}

/**
 * Returns the site facts that value validation needs.
 *
 * @return array{hosts: string[]} The hosts an absolute image URL may point at: this site only.
 */
function alcor_fields_env() {
	$hosts = array();
	foreach ( array( home_url( '/' ), site_url( '/' ), content_url( '/' ) ) as $url ) {
		$host = wp_parse_url( $url, PHP_URL_HOST );
		if ( $host ) {
			$hosts[] = strtolower( $host );
		}
	}
	return array( 'hosts' => array_values( array_unique( $hosts ) ) );
}

/* ---------------------------------------------------------------------- render */

/**
 * Tells whether the current request is an editor's draft preview of this document.
 *
 * A preview needs all three: a signed-in user, permission to edit this very document, and a nonce made for this
 * user and document. The link therefore shows nothing to a visitor who is handed it.
 *
 * @param string $key Document key.
 * @return bool
 */
function alcor_fields_is_preview( $key ) {
	if ( ! isset( $_GET['alcor_fields_preview'] ) || ! is_string( $_GET['alcor_fields_preview'] ) || ! is_user_logged_in() ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- the nonce is verified on the next lines.
		return false;
	}
	$nonce = sanitize_text_field( wp_unslash( $_GET['alcor_fields_preview'] ) );
	return current_user_can( 'alcor_fields_edit_document', $key ) && wp_verify_nonce( $nonce, 'alcor_fields_preview_' . $key );
}

/**
 * Builds the signed link to the draft preview of a document.
 *
 * @param string $key Document key.
 * @return string The URL, or '' when the document has no public URL.
 */
function alcor_fields_preview_url( $key ) {
	$doc = alcor_fields_document( $key );
	if ( ! $doc || '' === $doc['view_url'] ) {
		return '';
	}
	return add_query_arg( 'alcor_fields_preview', wp_create_nonce( 'alcor_fields_preview_' . $key ), $doc['view_url'] );
}

/**
 * Renders the page with its published content (or, for an editor's preview link, its draft).
 *
 * Never throws and never shows an editor's broken state to visitors: if the template or the stored data cannot be
 * used, the authored page (minus annotations) is served and the problem is logged.
 *
 * @param string      $key           Document key.
 * @param string|null $fallback_html Markup to serve if the template file cannot be read.
 * @return string The page HTML.
 */
function alcor_fields_render_document( $key, $fallback_html = null ) {
	$doc      = alcor_fields_document( $key );
	$authored = null;
	try {
		if ( ! $doc ) {
			throw Alcor_Fields_Error::at( $key, 'no such document' );
		}
		$template = alcor_fields_template( $key );
		$authored = $template->html;
		$state    = Alcor_Fields_Store::load( $key );
		$preview  = alcor_fields_is_preview( $key );
		$source   = $preview && $state['draft'] ? $state['draft'] : $state['published'];
		if ( $preview ) {
			nocache_headers();
			header( 'X-Robots-Tag: noindex, nofollow', true );
		}
		if ( ! $source ) {
			return $template->render();
		}
		$clean = $template->validate_stored( $source, alcor_fields_env() );
		if ( $clean['dropped'] && ! $preview ) {
			error_log( 'AlcorFields: ' . $key . ' rendered with ' . count( $clean['dropped'] ) . ' stored value(s) the template no longer accepts' ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- operator-facing log line.
		}
		return $template->render( $clean['values'], $clean['hidden'] );
	} catch ( Throwable $e ) {
		error_log( 'AlcorFields: ' . $key . ' served as authored: ' . $e->getMessage() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- operator-facing log line.
		$html = $authored ?? ( $fallback_html ?? ( $doc && is_file( $doc['template'] ) ? (string) file_get_contents( $doc['template'] ) : '' ) );
		return Alcor_Fields_Template::strip_annotations( $html );
	}
}

/* ---------------------------------------------------------------------- export / import */

/**
 * Hashes the content of an export: its document key, hidden sections and values.
 *
 * @param string   $document Document key.
 * @param string[] $hidden   Hidden section keys.
 * @param array    $values   Field values.
 * @return string Hex SHA-256.
 */
function alcor_fields_content_sha256( $document, array $hidden, array $values ) {
	return hash(
		'sha256',
		wp_json_encode(
			array(
				'document' => $document,
				'hidden'   => array_values( $hidden ),
				'values'   => $values,
			),
			JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
		)
	);
}

/**
 * Builds the hand-off file: every field resolved (defaults included), so the receiving site needs nothing else.
 *
 * @param string $key   Document key.
 * @param string $which 'published' or 'draft'.
 * @return array The export, format alcor.fields.document.v1.
 */
function alcor_fields_export( $key, $which = 'published' ) {
	$template = alcor_fields_template( $key );
	$state    = Alcor_Fields_Store::load( $key );
	$source   = 'draft' === $which ? ( $state['draft'] ?? $state['published'] ) : $state['published'];
	$clean    = $source ? $template->validate_stored( $source, alcor_fields_env() ) : array(
		'values' => array(),
		'hidden' => array(),
	);
	$values   = $template->resolved( $clean['values'] );
	$doc      = alcor_fields_document( $key );
	return array(
		'format'          => 'alcor.fields.document.v1',
		'document'        => $key,
		'label'           => $doc['label'],
		'template_sha256' => $template->sha256,
		'state'           => 'draft' === $which && $state['draft'] ? 'draft' : 'published',
		'version'         => (int) $state['version'],
		'exported_at'     => gmdate( 'Y-m-d\TH:i:s\Z' ),
		'hidden'          => $clean['hidden'],
		'values'          => $values,
		'content_sha256'  => alcor_fields_content_sha256( $key, $clean['hidden'], $values ),
	);
}

/**
 * Validates a hand-off file for $key.
 *
 * The content hash detects a damaged or hand-edited file. It is not a signature (anyone can recompute it), so it
 * is never what makes an import safe: every imported value is validated against the template below, exactly like an
 * editor's save.
 *
 * @param string $key    Document key the file is being loaded into.
 * @param mixed  $export The decoded file.
 * @return array Validated content (values and hidden), ready to store as a draft.
 * @throws Alcor_Fields_Error When the file is not an export, belongs to another design, was changed, or holds invalid values.
 */
function alcor_fields_import_document( $key, $export ) {
	if ( ! is_array( $export ) || 'alcor.fields.document.v1' !== ( $export['format'] ?? '' ) ) {
		throw Alcor_Fields_Error::at( 'import', 'not an AlcorFields export (format alcor.fields.document.v1)' );
	}
	$template = alcor_fields_template( $key );
	$source   = $export['document'] ?? null;
	$digest   = $export['content_sha256'] ?? null;
	if ( ! is_string( $source ) || ! is_string( $digest ) || ! is_string( $export['template_sha256'] ?? null ) ) {
		throw Alcor_Fields_Error::at( 'import', 'document, template_sha256 and content_sha256 must be present' );
	}
	if ( $source !== $key && $export['template_sha256'] !== $template->sha256 ) {
		throw Alcor_Fields_Error::at( 'import', 'this file belongs to document ' . sanitize_key( $source ) . ', not ' . $key );
	}
	$hidden = $export['hidden'] ?? array();
	$values = $export['values'] ?? array();
	if ( ! is_array( $hidden ) || ! is_array( $values ) ) {
		throw Alcor_Fields_Error::at( 'import', 'hidden and values must be present' );
	}
	if ( ! hash_equals( alcor_fields_content_sha256( $source, $hidden, $values ), $digest ) ) {
		throw Alcor_Fields_Error::at( 'import', 'content_sha256 does not match: the file was changed or damaged after export' );
	}
	return $template->validate(
		array(
			'values' => $values,
			'hidden' => $hidden,
		),
		alcor_fields_env()
	);
}

Alcor_Fields_Access::boot();
Alcor_Fields_Admin::boot();
Alcor_Fields_REST::boot();
