<?php
/**
 * Plugin Name: Alcor Public Sitemap
 * Description: Adds virtual routes (pages that code serves, not posts) to the WordPress sitemaps, and keeps sitemap responses from inheriting a 404 status.
 * Version: 1.0.0
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * Author: Alcor Industries
 *
 * Core sitemaps (/wp-sitemap.xml) list posts, pages, taxonomies and users. A route that a plugin serves with
 * template_redirect has no post behind it, so core never lists it. The "alcorroutes" provider added here lists
 * those routes. A route plugin registers its public path next to the code that serves it:
 *
 *     add_filter( 'alcor_public_routes', static function ( $paths ) {
 *         $paths[] = '/pricing/';
 *         return $paths;
 *     } );
 *
 * Registered paths must be same-origin, lowercase and slash-wrapped ('/pricing/'). Editor and admin paths are
 * dropped (they are noindex), and each route is listed once. Pages that must stay out of the index are named with
 * the alcor_sitemap_noindex_paths filter; they are left out of the page sitemap and sent noindex.
 *
 * It also removes the users and taxonomies sitemaps (this site has no author or category archives) and answers a
 * sitemap that WordPress did not render with a 404 instead of the homepage.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Lets a sitemap request through without core marking it a 404.
 *
 * A sitemap URL matches no post, so core's handle_404() would answer it with a 404 status even though the sitemap
 * renders. Returning true tells core the 404 decision was already made.
 *
 * @param bool     $preempt  Value from earlier callbacks; anything but false is respected.
 * @param WP_Query $wp_query The main query.
 * @return bool
 */
function alcor_public_sitemap_pre_handle_404( $preempt, $wp_query ) {
	if ( false !== $preempt ) {
		return $preempt;
	}
	if ( $wp_query->get( 'sitemap' ) || $wp_query->get( 'sitemap-stylesheet' ) ) {
		return true;
	}
	return $preempt;
}
add_filter( 'pre_handle_404', 'alcor_public_sitemap_pre_handle_404', 10, 2 );

/**
 * Drops the users and taxonomies sitemap providers.
 *
 * No author or category archive exists on this site: /category/<shelf>/ renders the homepage, so listing it would
 * advertise duplicate content, and the users sitemap would list account names (see alcor-no-user-enumeration.php).
 *
 * @param WP_Sitemaps_Provider|false $provider Provider core is about to register.
 * @param string                     $name     Provider name.
 * @return WP_Sitemaps_Provider|false The provider, or false to skip it.
 */
function alcor_public_sitemap_filter_provider( $provider, $name ) {
	return in_array( $name, array( 'users', 'taxonomies' ), true ) ? false : $provider;
}
add_filter( 'wp_sitemaps_add_provider', 'alcor_public_sitemap_filter_provider', 10, 2 );

/**
 * Makes a sitemap that WordPress did not render a 404, not the homepage.
 *
 * Runs after core's renderer (template_redirect priority 10). A sitemap it rendered has already ended the request;
 * anything still here named an unknown or removed provider, such as users.
 *
 * @return void
 */
function alcor_public_sitemap_unknown_is_404() {
	$sitemap = (string) get_query_var( 'sitemap' );
	if ( '' === $sitemap || 'index' === $sitemap || get_query_var( 'sitemap-stylesheet' ) ) {
		return;
	}
	global $wp_query;
	$wp_query->set_404();
	status_header( 404 );
	nocache_headers();
}
add_action( 'template_redirect', 'alcor_public_sitemap_unknown_is_404', 11 );

/**
 * Returns every path the "alcorroutes" sitemap lists, once.
 *
 * App screens follow one rule: an editor or admin screen is noindex and is not listed; its landing page is.
 *
 * @return string[] Slash-wrapped paths such as "/pricing/".
 */
function alcor_public_sitemap_routes() {
	$paths = array();
	foreach ( (array) apply_filters( 'alcor_public_routes', array() ) as $path ) {
		if ( is_string( $path ) && preg_match( '#^/[a-z0-9/_-]+/$#', $path ) && ! preg_match( '#/(?:admin|editor)/$#', $path ) ) {
			$paths[] = $path;
		}
	}
	return array_values( array_unique( $paths ) );
}

/**
 * Returns the page paths that must stay out of search results.
 *
 * @return string[] Page paths as get_page_by_path() takes them, such as "embed/widget".
 */
function alcor_public_sitemap_noindex_paths() {
	return array_values( array_filter( (array) apply_filters( 'alcor_sitemap_noindex_paths', array() ), 'is_string' ) );
}

if ( class_exists( 'WP_Sitemaps_Provider' ) ) {
	/**
	 * Sitemap provider for the routes listed by alcor_public_sitemap_routes().
	 */
	final class Alcor_Public_Routes_Sitemap_Provider extends WP_Sitemaps_Provider {

		/**
		 * Names the provider; the name becomes part of the sitemap URL (wp-sitemap-alcorroutes-1.xml).
		 */
		public function __construct() {
			$this->name        = 'alcorroutes';
			$this->object_type = 'alcorroutes';
		}

		/**
		 * Lists the routes.
		 *
		 * An entry gets a lastmod only where a stored page backs the route; a route served by code has no honest
		 * edit date, and a made-up one would teach crawlers to ignore the field.
		 *
		 * @param int    $page_num       Sitemap page number; all routes fit on page 1.
		 * @param string $object_subtype Unused.
		 * @return array<int, array{loc: string, lastmod?: string}>
		 */
		public function get_url_list( $page_num, $object_subtype = '' ) {
			if ( 1 !== (int) $page_num ) {
				return array();
			}
			return array_map(
				static function ( $path ) {
					$entry = array( 'loc' => home_url( $path ) );
					$page  = get_page_by_path( trim( $path, '/' ) );
					if ( $page instanceof WP_Post && $page->post_modified_gmt && '0000-00-00 00:00:00' !== $page->post_modified_gmt ) {
						$entry['lastmod'] = mysql2date( DATE_W3C, $page->post_modified_gmt, false );
					}
					return $entry;
				},
				alcor_public_sitemap_routes()
			);
		}

		/**
		 * Returns the number of sitemap pages.
		 *
		 * @param string $object_subtype Unused.
		 * @return int Always 1.
		 */
		public function get_max_num_pages( $object_subtype = '' ) {
			return 1;
		}
	}
}

/**
 * Registers the "alcorroutes" provider.
 *
 * @return void
 */
function alcor_public_sitemap_register_provider() {
	if ( ! class_exists( 'Alcor_Public_Routes_Sitemap_Provider' ) || ! function_exists( 'wp_register_sitemap_provider' ) ) {
		return;
	}
	wp_register_sitemap_provider( 'alcorroutes', new Alcor_Public_Routes_Sitemap_Provider() );
}
add_action( 'init', 'alcor_public_sitemap_register_provider', 20 );

/**
 * Leaves noindex pages out of the page sitemap, and pages that the routes sitemap already lists (each URL once).
 *
 * @param array  $args      WP_Query arguments of the sitemap.
 * @param string $post_type Post type being listed.
 * @return array The arguments, with the excluded pages added to post__not_in.
 */
function alcor_public_sitemap_exclude_pages( $args, $post_type ) {
	if ( 'page' !== $post_type ) {
		return $args;
	}
	$paths = alcor_public_sitemap_noindex_paths();
	foreach ( alcor_public_sitemap_routes() as $route ) {
		$paths[] = trim( $route, '/' );
	}
	foreach ( $paths as $path ) {
		$page = get_page_by_path( $path );
		if ( $page ) {
			$args['post__not_in'] = array_merge( (array) ( $args['post__not_in'] ?? array() ), array( (int) $page->ID ) );
		}
	}
	return $args;
}
add_filter( 'wp_sitemaps_posts_query_args', 'alcor_public_sitemap_exclude_pages', 10, 2 );

/**
 * Sends noindex for the pages named with alcor_sitemap_noindex_paths.
 *
 * @param array<string, bool|string> $robots Directives core is about to print.
 * @return array<string, bool|string> The directives, with noindex added for a listed page.
 */
function alcor_public_sitemap_robots( $robots ) {
	$uri  = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : '/'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- only compared with fixed strings.
	$path = trim( (string) wp_parse_url( (string) $uri, PHP_URL_PATH ), '/' );
	if ( in_array( $path, alcor_public_sitemap_noindex_paths(), true ) ) {
		$robots['noindex'] = true;
		$robots['follow']  = true;
	}
	return $robots;
}
add_filter( 'wp_robots', 'alcor_public_sitemap_robots' );
