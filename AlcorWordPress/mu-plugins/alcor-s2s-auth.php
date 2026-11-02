<?php
/**
 * Plugin Name: Alcor service-to-service authentication
 * Description: HMAC request verification for REST routes that an external system calls. Inert until a key constant is defined.
 * Version: 1.0.0
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * Author: Alcor Industries
 *
 * WordPress stays the public front door; a back-office system (an ERP, a billing job, a CI task) calls it, so the
 * back-office system never has to accept connections from the internet. A route opts in by calling
 * alcor_s2s_verify() from its permission_callback with the name of the constant that holds its key:
 *
 *     'permission_callback' => static function ( WP_REST_Request $request ) {
 *         return alcor_s2s_verify( $request, 'ALCOR_ORDERS_KEY' );
 *     },
 *
 * Wire format. The caller sends three headers:
 *
 *     X-Alcor-Timestamp  Unix seconds, ten digits.
 *     X-Alcor-Nonce      32 lowercase hex characters, never reused.
 *     X-Alcor-Signature  64 lowercase hex characters: HMAC-SHA256 of the canonical string, keyed with the secret.
 *
 * The canonical string is these seven lines joined with "\n" (see examples/sign_request.py for a signer):
 *
 *     alcor-s2s-v1
 *     METHOD                        upper case
 *     /route                        WP_REST_Request::get_route(): no /wp-json prefix, no trailing slash
 *     k1=v1&k2=v2                   query parameters sorted by name, RFC 3986 percent-encoded, rest_route left out
 *     timestamp
 *     nonce
 *     sha256(body)                  lower-case hex digest of the raw request body (of "" for a GET)
 *
 * Keys live only in server configuration (wp-config.php or the host's secret store), never in Git or in options.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * How far a request timestamp may be from the server clock, in seconds, in either direction.
 *
 * Five minutes tolerates ordinary clock drift between two machines. It also bounds how long the nonce table has to
 * remember a request: see the clean-up at the end of alcor_s2s_verify().
 */
const ALCOR_S2S_MAX_SKEW = 300;

/**
 * Builds the string that the caller signs and the server recomputes.
 *
 * Every field that changes what a request does is bound into it (method, route, query, body), as are the two
 * values that make it single-use (timestamp, nonce). Changing any of them after signing breaks the signature.
 *
 * @param string               $method    HTTP method.
 * @param string               $route     REST route, as WP_REST_Request::get_route() reports it.
 * @param array<string, mixed> $query     Query parameters.
 * @param string               $timestamp Unix seconds.
 * @param string               $nonce     Per-request nonce.
 * @param string               $body      Raw request body.
 * @return string|null The canonical string, or null when a query value is not a scalar (a signer cannot produce it).
 */
function alcor_s2s_canonical( $method, $route, array $query, $timestamp, $nonce, $body ) {
	// The route is already in the string; rest_route is how plain permalinks spell it.
	unset( $query['rest_route'] );
	// Sort by name so the order the caller wrote the parameters in does not matter.
	ksort( $query, SORT_STRING );
	$pairs = array();
	foreach ( $query as $name => $value ) {
		if ( ! is_scalar( $value ) ) {
			return null;
		}
		$pairs[] = rawurlencode( (string) $name ) . '=' . rawurlencode( (string) $value );
	}
	return implode(
		"\n",
		array(
			'alcor-s2s-v1',
			strtoupper( (string) $method ),
			(string) $route,
			implode( '&', $pairs ),
			(string) $timestamp,
			(string) $nonce,
			hash( 'sha256', (string) $body ),
		)
	);
}

/**
 * Looks up a signing key by the name of the constant that holds it.
 *
 * Only constants named ALCOR_<NAME>_KEY are read, so a route cannot be pointed at an unrelated constant such as a
 * database password. Keys shorter than 32 bytes are treated as not configured.
 *
 * @param mixed $constant Constant name.
 * @return string|null The key, or null when the constant is missing, malformed or too short.
 */
function alcor_s2s_key( $constant ) {
	if ( ! is_string( $constant ) || ! preg_match( '/^ALCOR_[A-Z0-9_]{3,60}_KEY$/D', $constant ) || ! defined( $constant ) ) {
		return null;
	}
	$key = constant( $constant );
	return is_string( $key ) && strlen( $key ) >= 32 ? $key : null;
}

/**
 * Tells whether the request arrived over a transport that may carry a signed request.
 *
 * The signature stops tampering and replay, not eavesdropping, so the request must be HTTPS. The one exception is an
 * explicit local test setup: the ALCOR_S2S_LOCAL_QA constant, a WordPress environment type of "local", and a
 * loopback client address must all hold at once.
 *
 * @return bool True when HTTPS, or when the loopback test setup is active.
 */
function alcor_s2s_transport_ok() {
	if ( is_ssl() ) {
		return true;
	}
	return defined( 'ALCOR_S2S_LOCAL_QA' ) && true === ALCOR_S2S_LOCAL_QA
		&& function_exists( 'wp_get_environment_type' ) && 'local' === wp_get_environment_type()
		&& in_array( $_SERVER['REMOTE_ADDR'] ?? '', array( '127.0.0.1', '::1' ), true );
}

/**
 * Verifies a signed request. Use it as a REST route's permission_callback.
 *
 * Fails closed. A missing key answers 404, so a disabled integration looks the same as a route that does not exist.
 * Every other failure answers the same 401 and never says which check failed, so a caller learns nothing about
 * how close a forgery was. A replayed nonce inside the skew window is refused; a write must still be idempotent
 * on its own key, because a lost response is retried with a new nonce.
 *
 * @param WP_REST_Request $request  The request being authorised.
 * @param string          $constant Name of the constant that holds the shared key, such as ALCOR_ORDERS_KEY.
 * @return true|WP_Error True when the request is authentic and new; otherwise a 404 or 401 error.
 */
function alcor_s2s_verify( $request, $constant ) {
	$key = alcor_s2s_key( $constant );
	if ( null === $key ) {
		return new WP_Error( 'alcor_s2s_disabled', 'Not found.', array( 'status' => 404 ) );
	}
	$denied = new WP_Error( 'alcor_s2s_denied', 'Request is not authorized.', array( 'status' => 401 ) );
	if ( ! alcor_s2s_transport_ok() ) {
		return $denied;
	}
	$timestamp = (string) $request->get_header( 'x-alcor-timestamp' );
	$nonce     = (string) $request->get_header( 'x-alcor-nonce' );
	$signature = (string) $request->get_header( 'x-alcor-signature' );
	// Reject malformed input before any work is done on it.
	if ( ! preg_match( '/^[0-9]{10}$/D', $timestamp ) || ! preg_match( '/^[a-f0-9]{32}$/D', $nonce )
		|| ! preg_match( '/^[a-f0-9]{64}$/D', $signature ) ) {
		return $denied;
	}
	// A stale or future-dated request is refused even when its signature is right.
	if ( abs( time() - (int) $timestamp ) > ALCOR_S2S_MAX_SKEW ) {
		return $denied;
	}
	$canonical = alcor_s2s_canonical(
		$request->get_method(),
		$request->get_route(),
		(array) $request->get_query_params(),
		$timestamp,
		$nonce,
		$request->get_body()
	);
	// hash_equals() compares in constant time. A plain === would leak, through response timing, how many leading
	// characters of a guessed signature were right.
	if ( null === $canonical || ! hash_equals( hash_hmac( 'sha256', $canonical, $key ), $signature ) ) {
		return $denied;
	}
	// The nonce is stored only after the signature verified, so someone without the key cannot grow the table.
	// One atomic insert on the unique option name: two concurrent replays cannot both pass.
	global $wpdb;
	$seen     = 'alcor_s2s_nonce_' . substr( hash( 'sha256', $constant . '|' . $nonce ), 0, 40 );
	$inserted = $wpdb->query(
		$wpdb->prepare(
			"INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'off')",
			$seen,
			(string) time()
		)
	);
	if ( 1 !== $inserted ) {
		return $denied;
	}
	if ( 1 === random_int( 1, 50 ) ) {
		// A nonce can only be replayed while its timestamp is inside the window, which is at most twice the skew
		// after it was stored. Older rows can never be accepted again, so drop them.
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s AND option_value < %s",
				$wpdb->esc_like( 'alcor_s2s_nonce_' ) . '%',
				(string) ( time() - 2 * ALCOR_S2S_MAX_SKEW )
			)
		);
	}
	return true;
}
