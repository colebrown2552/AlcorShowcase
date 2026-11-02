<?php
/**
 * AlcorFields REST API: alcor-fields/v1.
 *
 * The same rules as the editor screen: same validation, same per-document access, same version check.
 * Authentication is WordPress's own: a logged-in cookie with the X-WP-Nonce header, or an application password,
 * which is how a developer can load a client's content without sharing the client's login.
 *
 *   GET  /documents                          documents the caller may edit
 *   GET  /documents/<key>                    schema, live and draft content, version
 *   POST /documents/<key>/draft              {base_version, values, hidden}
 *   POST /documents/<key>/publish            {base_version[, values, hidden]}  (without values: publish the draft)
 *   POST /documents/<key>/restore            {base_version, version}
 *   GET  /documents/<key>/export?state=      published (default) or draft: the hand-off file
 *   POST /documents/<key>/import             {base_version, document: <hand-off file>}  -> draft
 *
 * Errors: 401 not signed in, 403 no access, 404 unknown document, 409 version conflict, 422 invalid content with
 * every problem listed.
 *
 * Every route has a permission_callback. WordPress treats a route without one as public (and logs a notice), so a
 * missing callback is a hole; here each one names who may call it, and the per-document routes share one callback
 * so the rule cannot drift between them.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Registers the routes and turns their results into REST responses.
 */
final class Alcor_Fields_REST {

	const NS = 'alcor-fields/v1';

	/**
	 * Hooks route registration.
	 *
	 * @return void
	 */
	public static function boot() {
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
	}

	/**
	 * Registers every route.
	 *
	 * @return void
	 */
	public static function routes() {
		$key = '(?P<key>[a-z0-9][a-z0-9-]{0,63})';
		register_rest_route(
			self::NS,
			'/documents',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'index' ),
				'permission_callback' => static function () {
					return current_user_can( 'alcor_fields_edit' );
				},
			)
		);
		$can = array( __CLASS__, 'can' );
		register_rest_route(
			self::NS,
			'/documents/' . $key,
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'show' ),
				'permission_callback' => $can,
			)
		);
		register_rest_route(
			self::NS,
			'/documents/' . $key . '/draft',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'draft' ),
				'permission_callback' => $can,
			)
		);
		register_rest_route(
			self::NS,
			'/documents/' . $key . '/publish',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'publish' ),
				'permission_callback' => $can,
			)
		);
		register_rest_route(
			self::NS,
			'/documents/' . $key . '/restore',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'restore' ),
				'permission_callback' => $can,
			)
		);
		register_rest_route(
			self::NS,
			'/documents/' . $key . '/export',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'export' ),
				'permission_callback' => $can,
			)
		);
		register_rest_route(
			self::NS,
			'/documents/' . $key . '/import',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'import' ),
				'permission_callback' => $can,
			)
		);
	}

	/**
	 * Permission callback of every per-document route.
	 *
	 * The checks run from the least to the most specific, and each stage answers before the next one is allowed to
	 * say anything about the document. An anonymous caller learns nothing beyond "sign in", and a signed-in user
	 * with no site-content access cannot tell a document that exists from one that does not.
	 *
	 * @param WP_REST_Request $request The request; its "key" parameter names the document.
	 * @return true|WP_Error True when allowed; otherwise a 401, 403 or 404 error.
	 */
	public static function can( WP_REST_Request $request ) {
		$key = (string) $request['key'];
		if ( ! is_user_logged_in() ) {
			return new WP_Error( 'rest_not_logged_in', 'Sign in to edit site content.', array( 'status' => 401 ) );
		}
		if ( ! current_user_can( 'alcor_fields_edit' ) ) {
			return new WP_Error( 'rest_forbidden', 'You cannot edit this content.', array( 'status' => 403 ) );
		}
		if ( ! alcor_fields_document( $key ) ) {
			return new WP_Error( 'alcor_fields_not_found', 'No such document.', array( 'status' => 404 ) );
		}
		return current_user_can( 'alcor_fields_edit_document', $key )
			? true : new WP_Error( 'rest_forbidden', 'You cannot edit this content.', array( 'status' => 403 ) );
	}

	/**
	 * Summarises a document for lists.
	 *
	 * @param array $doc A registered document.
	 * @return array
	 * @throws RuntimeException When the stored row is damaged.
	 */
	private static function summary( array $doc ) {
		$state = Alcor_Fields_Store::load( $doc['key'] );
		return array(
			'key'               => $doc['key'],
			'label'             => $doc['label'],
			'group'             => $doc['group'],
			'view_url'          => $doc['view_url'],
			'version'           => $state['version'],
			'has_draft'         => (bool) $state['draft'],
			'published_version' => $state['published'] ? (int) ( $state['published']['version'] ?? 0 ) : null,
		);
	}

	/**
	 * GET /documents.
	 *
	 * @return WP_REST_Response The documents the caller may edit.
	 */
	public static function index() {
		$out = array();
		foreach ( Alcor_Fields_Access::editable_documents() as $doc ) {
			try {
				$out[] = self::summary( $doc );
			} catch ( Throwable $e ) {
				// One damaged document must not hide the others.
				$out[] = array(
					'key'      => $doc['key'],
					'label'    => $doc['label'],
					'group'    => $doc['group'],
					'view_url' => $doc['view_url'],
					'error'    => 'stored content unreadable',
				);
			}
		}
		return rest_ensure_response( $out );
	}

	/**
	 * GET /documents/<key>.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response|WP_Error Schema, live and draft content, history and version.
	 */
	public static function show( WP_REST_Request $request ) {
		$key = (string) $request['key'];
		return self::guard(
			static function () use ( $key ) {
				$template = alcor_fields_template( $key );
				$state    = Alcor_Fields_Store::load( $key, true );
				$view     = static function ( $entry ) use ( $template ) {
					if ( ! $entry ) {
						return null;
					}
					$clean = $template->validate_stored( $entry, alcor_fields_env() );
					return array(
						'values'   => $template->resolved( $clean['values'] ),
						'hidden'   => $clean['hidden'],
						'dropped'  => $clean['dropped'],
						'saved_at' => $entry['saved_at'] ?? null,
						'saved_by' => (int) ( $entry['saved_by'] ?? 0 ),
						'note'     => (string) ( $entry['note'] ?? '' ),
					);
				};
				$history  = array_map(
					static function ( $e ) {
						return array(
							'version'  => (int) ( $e['version'] ?? 0 ),
							'saved_at' => $e['saved_at'] ?? null,
							'saved_by' => (int) ( $e['saved_by'] ?? 0 ),
							'note'     => (string) ( $e['note'] ?? '' ),
						);
					},
					$state['history']
				);
				return self::summary( alcor_fields_document( $key ) ) + array(
					'schema'      => $template->schema(),
					'published'   => $view( $state['published'] ),
					'draft'       => $view( $state['draft'] ),
					'history'     => $history,
					'preview_url' => $state['draft'] ? alcor_fields_preview_url( $key ) : '',
				);
			}
		);
	}

	/**
	 * Reads the JSON body and checks the one field every write needs.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return array The decoded body.
	 * @throws Alcor_Fields_Error When the body is not a JSON object or base_version is not an integer.
	 */
	private static function body( WP_REST_Request $request ) {
		$body = $request->get_json_params();
		if ( ! is_array( $body ) ) {
			throw Alcor_Fields_Error::at( 'body', 'send a JSON object' );
		}
		if ( ! isset( $body['base_version'] ) || ! is_int( $body['base_version'] ) ) {
			throw Alcor_Fields_Error::at( 'base_version', 'required: the version you edited (integer)' );
		}
		return $body;
	}

	/**
	 * Picks the document fields out of a request body.
	 *
	 * @param array $body The decoded body.
	 * @return array values and hidden, as the template validator expects them.
	 */
	private static function doc( array $body ) {
		return array(
			'values' => $body['values'] ?? array(),
			'hidden' => $body['hidden'] ?? array(),
		);
	}

	/**
	 * POST /documents/<key>/draft.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response|WP_Error The new version and a preview link.
	 */
	public static function draft( WP_REST_Request $request ) {
		$key = (string) $request['key'];
		return self::guard(
			static function () use ( $key, $request ) {
				$body  = self::body( $request );
				$state = Alcor_Fields_Store::save_draft( $key, $body['base_version'], alcor_fields_template( $key )->validate( self::doc( $body ), alcor_fields_env() ), self::note( $body ) );
				return array(
					'version'     => $state['version'],
					'state'       => 'draft',
					'preview_url' => alcor_fields_preview_url( $key ),
				);
			}
		);
	}

	/**
	 * POST /documents/<key>/publish.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response|WP_Error The new version, plus any values that fell back to the authored text.
	 */
	public static function publish( WP_REST_Request $request ) {
		$key = (string) $request['key'];
		return self::guard(
			static function () use ( $key, $request ) {
				$body     = self::body( $request );
				$template = alcor_fields_template( $key );
				$clean    = array_key_exists( 'values', $body ) || array_key_exists( 'hidden', $body )
					? $template->validate( self::doc( $body ), alcor_fields_env() ) : null;
				// Publishing the draft repairs it against today's design; say what (if anything) fell back.
				$draft   = null === $clean ? Alcor_Fields_Store::load( $key, true )['draft'] : null;
				$dropped = $draft ? $template->validate_stored( $draft, alcor_fields_env() )['dropped'] : array();
				$state   = Alcor_Fields_Store::publish( $key, $body['base_version'], $clean, self::note( $body ) );
				return array(
					'version'           => $state['version'],
					'state'             => 'published',
					'published_version' => (int) $state['published']['version'],
					'dropped'           => $dropped,
				);
			}
		);
	}

	/**
	 * POST /documents/<key>/restore.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response|WP_Error The new version; the restored content is now the draft.
	 */
	public static function restore( WP_REST_Request $request ) {
		$key = (string) $request['key'];
		return self::guard(
			static function () use ( $key, $request ) {
				$body = self::body( $request );
				if ( ! isset( $body['version'] ) || ! is_int( $body['version'] ) ) {
					throw Alcor_Fields_Error::at( 'version', 'required: the published version to copy into the draft' );
				}
				$state = Alcor_Fields_Store::restore( $key, $body['base_version'], $body['version'] );
				return array(
					'version' => $state['version'],
					'state'   => 'draft',
				);
			}
		);
	}

	/**
	 * GET /documents/<key>/export.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response|WP_Error The hand-off file.
	 */
	public static function export( WP_REST_Request $request ) {
		$key = (string) $request['key'];
		return self::guard(
			static function () use ( $key, $request ) {
				return alcor_fields_export( $key, 'draft' === $request->get_param( 'state' ) ? 'draft' : 'published' );
			}
		);
	}

	/**
	 * POST /documents/<key>/import.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response|WP_Error The new version; the imported content is now the draft.
	 */
	public static function import( WP_REST_Request $request ) {
		$key = (string) $request['key'];
		return self::guard(
			static function () use ( $key, $request ) {
				$body  = self::body( $request );
				$clean = alcor_fields_import_document( $key, $body['document'] ?? null );
				$state = Alcor_Fields_Store::save_draft( $key, $body['base_version'], $clean, 'Imported from file' );
				return array(
					'version'     => $state['version'],
					'state'       => 'draft',
					'preview_url' => alcor_fields_preview_url( $key ),
				);
			}
		);
	}

	/**
	 * Reads the optional note that is stored with a version.
	 *
	 * @param array $body The decoded body.
	 * @return string At most 200 characters of plain text.
	 */
	private static function note( array $body ) {
		return isset( $body['note'] ) && is_string( $body['note'] ) ? mb_substr( sanitize_text_field( $body['note'] ), 0, 200 ) : '';
	}

	/**
	 * Runs a handler and maps its outcome to a response.
	 *
	 * Invalid content is 422 with every problem; a version conflict is 409; anything unexpected is logged and
	 * reported as a generic 500 so no internal detail leaves the server.
	 *
	 * @param callable $fn Handler that returns the response data.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function guard( callable $fn ) {
		try {
			return rest_ensure_response( $fn() );
		} catch ( Alcor_Fields_Error $e ) {
			return new WP_Error(
				'alcor_fields_invalid',
				'The content was not saved.',
				array(
					'status' => 422,
					'errors' => $e->errors,
				)
			);
		} catch ( Alcor_Fields_Conflict $e ) {
			return new WP_Error( 'alcor_fields_conflict', $e->getMessage(), array( 'status' => 409 ) );
		} catch ( Throwable $e ) {
			error_log( 'AlcorFields REST: ' . $e->getMessage() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- the only place a server-side failure is recorded.
			return new WP_Error( 'alcor_fields_error', 'Site content is unavailable.', array( 'status' => 500 ) );
		}
	}
}
