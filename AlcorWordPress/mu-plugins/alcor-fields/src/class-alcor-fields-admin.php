<?php
/**
 * AlcorFields admin screens: the wp-admin pages where an administrator or a client edits a document.
 *
 * Plain forms that work without JavaScript (admin-post.php, nonces, capability checks on every action). The
 * enqueued admin.js adds the rich-text toolbar, list add/remove/reorder, the media picker, and submits the whole form
 * as one JSON field so PHP's max_input_vars can never silently drop part of a large page. Without JavaScript, a
 * sentinel at the end of the form detects truncation and the save is refused. No inline script.
 *
 * Every action handler starts with require_document() (capability for that document) and check_admin_referer()
 * (a nonce bound to the document), in that order, before it reads anything else from the request.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Menu page, form rendering and the admin-post actions.
 */
final class Alcor_Fields_Admin {

	const SLUG = 'alcor-fields';

	/**
	 * Base URL that relative image paths in the current document resolve against (for previews).
	 *
	 * @var string
	 */
	private static $asset_base = '';

	/**
	 * Editor-facing names for the element a text field sits in.
	 */
	const ELEMENT_HINTS = array(
		'title'      => 'Browser tab title',
		'h1'         => 'Main heading',
		'h2'         => 'Section heading',
		'h3'         => 'Heading',
		'h4'         => 'Heading',
		'h5'         => 'Heading',
		'h6'         => 'Heading',
		'p'          => 'Paragraph',
		'li'         => 'List item',
		'dt'         => 'Term',
		'dd'         => 'Detail',
		'figcaption' => 'Caption',
		'blockquote' => 'Quote',
		'label'      => 'Form label',
		'button'     => 'Button',
		'a'          => 'Link text',
		'span'       => 'Text',
		'small'      => 'Small print',
		'strong'     => 'Text',
		'td'         => 'Table cell',
		'th'         => 'Table heading',
		'caption'    => 'Table caption',
		'summary'    => 'Question',
		'legend'     => 'Form group',
		'cite'       => 'Citation',
		'option'     => 'Choice',
		'time'       => 'Time',
		'address'    => 'Address',
		'div'        => 'Text',
		'em'         => 'Text',
		'b'          => 'Text',
		'q'          => 'Quotation',
	);

	/**
	 * Editor-facing names for an attribute that is a field.
	 */
	const ATTR_HINTS = array(
		'href'       => 'Link goes to',
		'src'        => 'Image',
		'alt'        => 'Image description (for screen readers; empty if decorative)',
		'content'    => 'Search engine description',
		'title'      => 'Tooltip',
		'aria-label' => 'Screen reader label',
		'width'      => 'Image width (px)',
		'height'     => 'Image height (px)',
	);

	/**
	 * Hooks the menu, the assets and the form actions.
	 *
	 * @return void
	 */
	public static function boot() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
		add_action( 'admin_post_alcor_fields_save', array( __CLASS__, 'handle_save' ) );
		add_action( 'admin_post_alcor_fields_restore', array( __CLASS__, 'handle_restore' ) );
		add_action( 'admin_post_alcor_fields_import', array( __CLASS__, 'handle_import' ) );
		add_action( 'admin_post_alcor_fields_export', array( __CLASS__, 'handle_export' ) );
		add_action( 'admin_post_alcor_fields_quarantine', array( __CLASS__, 'handle_quarantine' ) );
	}

	/**
	 * Adds the "Site content" menu page.
	 *
	 * @return void
	 */
	public static function menu() {
		$hook = add_menu_page( 'Site content', 'Site content', 'alcor_fields_edit', self::SLUG, array( __CLASS__, 'page' ), 'dashicons-layout', 21 );
		add_action( 'load-' . $hook, array( __CLASS__, 'guard' ) );
	}

	/**
	 * Refuses an unknown or unassigned document before wp-admin sends any output, so the status really is 403/404.
	 *
	 * @return void
	 */
	public static function guard() {
		if ( ! isset( $_GET['document'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only routing check.
			return;
		}
		$key = self::requested_key();
		if ( '' === $key ) {
			wp_die( esc_html__( 'That page does not exist.' ), 404 );
		}
		if ( ! current_user_can( 'alcor_fields_edit_document', $key ) ) {
			wp_die( esc_html__( 'You cannot edit this content.' ), 403 );
		}
	}

	/**
	 * Enqueues the editor's stylesheet, script and media library on the editor screen only.
	 *
	 * @param string $hook Admin page hook suffix.
	 * @return void
	 */
	public static function assets( $hook ) {
		if ( 'toplevel_page_' . self::SLUG !== $hook ) {
			return;
		}
		$base = plugins_url( 'assets/', ALCOR_FIELDS_DIR . '/alcor-fields.php' );
		$ver  = ALCOR_FIELDS_VERSION . '-' . substr( md5_file( ALCOR_FIELDS_DIR . '/assets/admin.js' ) . md5_file( ALCOR_FIELDS_DIR . '/assets/admin.css' ), 0, 10 );
		wp_enqueue_style( 'alcor-fields-admin', $base . 'admin.css', array(), $ver );
		wp_enqueue_script(
			'alcor-fields-admin',
			$base . 'admin.js',
			array(),
			$ver,
			array(
				'in_footer' => true,
				'strategy'  => 'defer',
			)
		);
		if ( isset( $_GET['document'] ) && current_user_can( 'upload_files' ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only routing check.
			wp_enqueue_media();
		}
	}

	/**
	 * Builds a URL of the Site content screen.
	 *
	 * @param array $args Query arguments to add.
	 * @return string
	 */
	private static function url( array $args = array() ) {
		return add_query_arg( $args, admin_url( 'admin.php?page=' . self::SLUG ) );
	}

	/**
	 * Returns the document key named in the request, if it is a registered document.
	 *
	 * @return string The key, or '' when there is none or it is unknown.
	 */
	private static function requested_key() {
		$key = isset( $_REQUEST['document'] ) && is_string( $_REQUEST['document'] ) ? sanitize_key( wp_unslash( $_REQUEST['document'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- the key only selects which document to check access to.
		return alcor_fields_document( $key ) ? $key : '';
	}

	/**
	 * Returns the requested document key, or ends the request with 403 when the user may not edit it.
	 *
	 * @return string The document key.
	 */
	private static function require_document() {
		$key = self::requested_key();
		if ( '' === $key || ! current_user_can( 'alcor_fields_edit_document', $key ) ) {
			wp_die( esc_html__( 'You cannot edit this content.' ), 403 );
		}
		return $key;
	}

	/**
	 * Returns the transient name that carries a message across the redirect after an action.
	 *
	 * @param string $key Document key.
	 * @return string
	 */
	private static function flash_key( $key ) {
		return 'alcor_fields_flash_' . get_current_user_id() . '_' . md5( $key );
	}

	/* ------------------------------------------------------------------ pages */

	/**
	 * Prints the Site content screen: the list of documents, or one document's editor.
	 *
	 * @return void
	 */
	public static function page() {
		$key = self::requested_key();
		if ( '' === $key ) {
			self::list_page();
			return;
		}
		if ( ! current_user_can( 'alcor_fields_edit_document', $key ) ) {
			wp_die( esc_html__( 'You cannot edit this content.' ), 403 );
		}
		self::edit_page( $key );
	}

	/**
	 * Prints the table of documents the user may edit.
	 *
	 * @return void
	 */
	private static function list_page() {
		$docs = Alcor_Fields_Access::editable_documents();
		echo '<div class="wrap af-wrap"><h1>Site content</h1>';
		if ( ! $docs ) {
			echo '<p>No pages have been assigned to you yet. Ask the site administrator to give you access.</p></div>';
			return;
		}
		echo '<p>Pick a page to change its words, links, images and sections. Changes stay in a draft until you publish them.</p>';
		echo '<table class="widefat striped af-docs"><thead><tr><th scope="col">Page</th><th scope="col">Status</th><th scope="col">Last change</th><th scope="col"><span class="screen-reader-text">Actions</span></th></tr></thead><tbody>';
		$group = null;
		foreach ( $docs as $doc ) {
			if ( $doc['group'] !== $group ) {
				$group = $doc['group'];
				if ( '' !== $group ) {
					echo '<tr class="af-group-row"><th colspan="4" scope="rowgroup">' . esc_html( $group ) . '</th></tr>';
				}
			}
			try {
				$state  = Alcor_Fields_Store::load( $doc['key'] );
				$status = self::status_text( $state );
				$last   = $state['draft'] ?? $state['published'];
				$when   = $last ? self::who_when( $last ) : '—';
			} catch ( Throwable $e ) {
				$status = 'Stored content unreadable';
				$when   = '—';
			}
			echo '<tr><td><strong><a href="' . esc_url( self::url( array( 'document' => $doc['key'] ) ) ) . '">' . esc_html( $doc['label'] ) . '</a></strong></td>';
			echo '<td>' . esc_html( $status ) . '</td><td>' . esc_html( $when ) . '</td><td>';
			echo '<a class="button" href="' . esc_url( self::url( array( 'document' => $doc['key'] ) ) ) . '">Edit</a> ';
			if ( '' !== $doc['view_url'] ) {
				echo '<a class="button-link" href="' . esc_url( $doc['view_url'] ) . '" target="_blank" rel="noopener">View page<span class="screen-reader-text"> (opens in a new tab)</span></a>';
			}
			echo '</td></tr>';
		}
		echo '</tbody></table></div>';
	}

	/**
	 * Describes where a document is in its life, for the list.
	 *
	 * @param array $state Document state.
	 * @return string
	 */
	private static function status_text( array $state ) {
		if ( $state['draft'] && $state['published'] ) {
			return 'Published, with unpublished changes';
		}
		if ( $state['draft'] ) {
			return 'Draft (not live yet)';
		}
		if ( $state['published'] ) {
			return 'Published';
		}
		return 'Original content';
	}

	/**
	 * Formats "when and by whom" for a saved version.
	 *
	 * @param array $entry A draft, a published version or a history entry.
	 * @return string
	 */
	private static function who_when( array $entry ) {
		$user = get_userdata( (int) ( $entry['saved_by'] ?? 0 ) );
		$time = strtotime( (string) ( $entry['saved_at'] ?? '' ) );
		return ( $time ? wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $time ) : '' ) . ( $user ? ' · ' . $user->display_name : '' );
	}

	/**
	 * Prints one document's editor.
	 *
	 * @param string $key Document key.
	 * @return void
	 */
	private static function edit_page( $key ) {
		$doc = alcor_fields_document( $key );
		echo '<div class="wrap af-wrap"><h1>' . esc_html( $doc['label'] ) . '</h1>';
		echo '<p><a href="' . esc_url( self::url() ) . '">&larr; All site content</a></p>';
		try {
			$template = alcor_fields_template( $key );
			$state    = Alcor_Fields_Store::load( $key, true );
		} catch ( Throwable $e ) {
			echo '<div class="notice notice-error"><p>' . esc_html( 'This page cannot be edited right now: ' . $e->getMessage() ) . '</p></div>';
			if ( current_user_can( 'manage_options' ) && Alcor_Fields_Store::unreadable( $key ) ) {
				// Recovery for a damaged row: set it aside (kept as its own option for inspection) and start from the
				// original content. Visitors are already being served the original page.
				echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '"><input type="hidden" name="action" value="alcor_fields_quarantine">';
				echo '<input type="hidden" name="document" value="' . esc_attr( $key ) . '">';
				wp_nonce_field( 'alcor_fields_quarantine_' . $key );
				echo '<p>The stored content for this page is unreadable. Visitors see the original page. You can set the damaged copy aside (it is kept, not deleted) and start again from the original content.</p>';
				echo '<p><button type="submit" class="button" data-af-confirm="Set the unreadable stored content aside and start from the original?">Set aside and start over</button></p></form>';
			}
			echo '</div>';
			return;
		}
		$flash = get_transient( self::flash_key( $key ) );
		if ( $flash ) {
			delete_transient( self::flash_key( $key ) );
		}
		self::notices( $flash, $state );

		$source = $state['draft'] ?? $state['published'];
		$stored = $source ? $template->validate_stored( $source, alcor_fields_env() ) : array(
			'values'  => array(),
			'hidden'  => array(),
			'dropped' => array(),
		);
		if ( $stored['dropped'] ) {
			echo '<div class="notice notice-warning"><p>Some saved content no longer fits this page&rsquo;s design and is not shown; the original text is used there instead:</p><ul>';
			foreach ( array_slice( $stored['dropped'], 0, 20 ) as $d ) {
				echo '<li><code>' . esc_html( $d['path'] ) . '</code> ' . esc_html( $d['message'] ) . '</li>';
			}
			echo '</ul></div>';
		}
		$values = $template->resolved( $stored['values'] );
		$hidden = $stored['hidden'];
		if ( is_array( $flash ) && isset( $flash['doc'] ) ) {
			$values = array_replace( $values, (array) ( $flash['doc']['values'] ?? array() ) );
			$hidden = (array) ( $flash['doc']['hidden'] ?? array() );
		}
		$errors = array();
		foreach ( (array) ( $flash['errors'] ?? array() ) as $e ) {
			$errors[ (string) $e['path'] ] = (string) $e['message'];
		}

		echo '<div class="af-layout"><div class="af-main">';
		self::$asset_base = $doc['asset_base_url'];
		echo '<form id="af-form" class="af-form" method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" data-af-document="' . esc_attr( $key ) . '" data-af-asset-base="' . esc_attr( $doc['asset_base_url'] ) . '" novalidate>';
		echo '<input type="hidden" name="action" value="alcor_fields_save"><input type="hidden" name="document" value="' . esc_attr( $key ) . '">';
		echo '<input type="hidden" name="af_base_version" value="' . esc_attr( (string) $state['version'] ) . '">';
		echo '<input type="hidden" name="af_json" value="" data-af-json>';
		// The form's default button, for Enter in a text box: disabled, so pressing Enter never submits (and so
		// never publishes). Saving always takes a deliberate click on Save draft or Publish.
		echo '<button type="submit" class="af-default-submit" disabled hidden aria-hidden="true" tabindex="-1"></button>';
		wp_nonce_field( 'alcor_fields_save_' . $key );
		self::toolbar( $key, $state, $doc );
		echo '<div class="af-filter"><label for="af-filter">Find a field</label> <input id="af-filter" type="search" class="regular-text" placeholder="Type any word on the page" data-af-filter></div>';

		foreach ( $template->schema()['groups'] as $group ) {
			$is_hidden = '' !== $group['key'] && in_array( $group['key'], $hidden, true );
			$title     = self::group_title( $group );
			echo '<fieldset class="af-group' . ( $is_hidden ? ' is-hidden' : '' ) . '" id="af-group-' . esc_attr( '' !== $group['key'] ? $group['key'] : 'page' ) . '" data-af-group>';
			echo '<legend>' . esc_html( $title ) . '</legend>';
			if ( $group['hideable'] ) {
				echo '<label class="af-show"><input type="checkbox" name="af[shown][' . esc_attr( $group['key'] ) . ']" value="1"' . checked( ! $is_hidden, true, false ) . ' data-af-show> Show this section on the page</label>';
			}
			echo '<div class="af-group-body">';
			foreach ( $group['fields'] as $field ) {
				$value = $values[ $field['key'] ] ?? $field['default'];
				self::field( $field, $value, array( 'v', $field['key'] ), array( 'v', $field['key'] ), $errors, $field['key'] );
			}
			echo '</div></fieldset>';
		}
		echo '<input type="hidden" name="af[complete]" value="1">';
		self::toolbar( $key, $state, $doc );
		echo '</form></div>';
		self::sidebar( $key, $state, $template );
		echo '</div></div>';
	}

	/**
	 * Builds a group's heading: its label plus the first heading text inside it.
	 *
	 * @param array $group A group from Alcor_Fields_Template::schema().
	 * @return string
	 */
	private static function group_title( array $group ) {
		foreach ( $group['fields'] as $field ) {
			if ( 'field' === $field['type'] && in_array( $field['element'], array( 'h1', 'h2', 'h3' ), true ) && null === $field['attr'] ) {
				$text = trim( wp_strip_all_tags( html_entity_decode( $field['default'], ENT_QUOTES | ENT_HTML5, 'UTF-8' ) ) );
				if ( '' !== $text ) {
					return $group['label'] . ': ' . wp_trim_words( $text, 8, '…' );
				}
			}
		}
		return $group['label'];
	}

	/**
	 * Prints the Publish / Save draft / Preview / Discard bar.
	 *
	 * @param string $key   Document key.
	 * @param array  $state Document state.
	 * @param array  $doc   Registered document.
	 * @return void
	 */
	private static function toolbar( $key, array $state, array $doc ) {
		echo '<div class="af-toolbar">';
		echo '<button type="submit" class="button button-primary" name="af_action" value="publish">Publish</button> ';
		echo '<button type="submit" class="button" name="af_action" value="draft">Save draft</button> ';
		if ( $state['draft'] ) {
			$preview = alcor_fields_preview_url( $key );
			if ( '' !== $preview ) {
				echo '<a class="button" href="' . esc_url( $preview ) . '" target="_blank" rel="noopener">Preview draft<span class="screen-reader-text"> (opens in a new tab)</span></a> ';
			}
			echo '<button type="submit" class="button-link af-danger" name="af_action" value="discard" formnovalidate data-af-confirm="Throw away the unpublished draft?">Discard draft</button>';
		}
		if ( '' !== $doc['view_url'] ) {
			echo ' <a class="button-link" href="' . esc_url( $doc['view_url'] ) . '" target="_blank" rel="noopener">View live page<span class="screen-reader-text"> (opens in a new tab)</span></a>';
		}
		echo '</div>';
	}

	/**
	 * Prints the success or error notices and the status line above the form.
	 *
	 * @param mixed $flash The message left by the previous action, if any.
	 * @param array $state Document state.
	 * @return void
	 */
	private static function notices( $flash, array $state ) {
		$messages = array(
			'draft'   => 'Draft saved. It is not live until you publish it.',
			'publish' => 'Published. The live page now shows these changes.',
			'discard' => 'Draft discarded.',
			'reset'   => 'Draft reset to the original content. Publish to make it live.',
			'restore' => 'That version is now your draft. Publish to make it live.',
			'import'  => 'File imported as a draft. Review it, then publish.',
		);
		$msg      = isset( $_GET['af_msg'] ) && is_string( $_GET['af_msg'] ) ? sanitize_key( wp_unslash( $_GET['af_msg'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- selects one of the fixed messages above.
		if ( isset( $messages[ $msg ] ) && ! $flash ) {
			echo '<div class="notice notice-success is-dismissible"><p>' . esc_html( $messages[ $msg ] ) . '</p></div>';
		}
		if ( is_array( $flash ) && ! empty( $flash['message'] ) ) {
			echo '<div class="notice notice-error"><p>' . esc_html( $flash['message'] ) . '</p></div>';
		}
		if ( is_array( $flash ) && ! empty( $flash['errors'] ) ) {
			echo '<div class="notice notice-error" role="alert"><p><strong>Nothing was saved.</strong> Fix ' . count( $flash['errors'] ) . ' problem' . ( 1 === count( $flash['errors'] ) ? '' : 's' ) . ' below:</p><ul class="af-error-list">';
			foreach ( array_slice( $flash['errors'], 0, 30 ) as $e ) {
				echo '<li><a href="#' . esc_attr( self::field_id( (string) $e['path'] ) ) . '">' . esc_html( (string) $e['path'] ) . '</a>: ' . esc_html( (string) $e['message'] ) . '</li>';
			}
			echo '</ul></div>';
		}
		$line = $state['published'] ? 'Live: version ' . (int) ( $state['published']['version'] ?? 0 ) . ', published ' . self::who_when( $state['published'] ) . '.' : 'Live: the original content (nothing published yet).';
		if ( $state['draft'] ) {
			$line .= ' You have an unpublished draft from ' . self::who_when( $state['draft'] ) . '.';
		}
		echo '<p class="af-status">' . esc_html( $line ) . '</p>';
	}

	/**
	 * Turns a field path into an element id.
	 *
	 * @param string $path Field path such as "work.items[2].title".
	 * @return string
	 */
	private static function field_id( $path ) {
		return 'af-f-' . trim( preg_replace( '/[^a-z0-9]+/', '-', strtolower( $path ) ), '-' );
	}

	/**
	 * Builds a form input name such as af[v][hero.title] from path segments.
	 *
	 * @param array $segments Name segments; null stands for an empty "[]".
	 * @return string
	 */
	private static function name( array $segments ) {
		$name = 'af';
		foreach ( $segments as $s ) {
			$name .= '[' . ( null === $s ? '' : $s ) . ']';
		}
		return $name;
	}

	/**
	 * Prints one field or list.
	 *
	 * $pattern is the input name path with null at each list index (admin.js refills those from the rows' order
	 * in the page); $actual is the same path with today's indexes, for posting without JavaScript; $path is the
	 * human path used in errors (work.items[2].title).
	 *
	 * @param array  $field   Field or list from the schema.
	 * @param mixed  $value   Current value.
	 * @param array  $pattern Input name pattern.
	 * @param array  $actual  Input name with today's indexes.
	 * @param array  $errors  Error message per path.
	 * @param string $path    Human path.
	 * @return void
	 */
	private static function field( array $field, $value, array $pattern, array $actual, array $errors, $path ) {
		$id    = self::field_id( $path );
		$error = $errors[ $path ] ?? '';
		if ( 'list' === $field['type'] ) {
			self::list_field( $field, is_array( $value ) ? $value : array(), $pattern, $actual, $errors, $path, $id );
			return;
		}
		$hint    = null !== $field['attr'] ? ( self::ATTR_HINTS[ $field['attr'] ] ?? $field['attr'] ) : ( self::ELEMENT_HINTS[ $field['element'] ] ?? 'Text' );
		$name    = self::name( $actual );
		$pattern = esc_attr( wp_json_encode( $pattern ) );
		$common  = ' id="' . esc_attr( $id ) . '" name="' . esc_attr( $name ) . '" data-af-name="' . $pattern . '"' . ( $error ? ' aria-invalid="true" aria-describedby="' . esc_attr( $id ) . '-error"' : '' );
		echo '<div class="af-field af-kind-' . esc_attr( $field['kind'] ) . ( $error ? ' has-error' : '' ) . '" data-af-field>';
		$label = Alcor_Fields_Template::humanize( $field['key'] ) !== $field['label'] ? $field['label'] : $hint;
		echo '<label for="' . esc_attr( $id ) . '">' . esc_html( $label ) . ' <code class="af-key">' . esc_html( $path ) . '</code></label>';
		// After a refused save the form shows what was posted, which may not even be text.
		$value = is_string( $value ) ? $value : ( is_int( $value ) || is_float( $value ) ? (string) $value : '' );
		switch ( $field['kind'] ) {
			case 'inline':
				echo '<textarea class="af-rich-source large-text" rows="3"' . $common . ' data-af-rich data-af-classes="' . esc_attr( wp_json_encode( $field['classes'] ) ) . '" data-af-max="' . esc_attr( (string) $field['max'] ) . '"' . ( ! empty( $field['no_links'] ) ? ' data-af-no-links' : '' ) . '>' . esc_textarea( $value ) . '</textarea>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $common is built from escaped parts above.
				break;
			case 'text':
				if ( $field['multiline'] || mb_strlen( $value ) > 90 ) {
					echo '<textarea class="large-text" rows="' . ( mb_strlen( $value ) > 240 ? 5 : 3 ) . '"' . $common . ' maxlength="' . esc_attr( (string) $field['max'] ) . '"' . ( $field['required'] ? ' required' : '' ) . '>' . esc_textarea( $value ) . '</textarea>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $common is built from escaped parts above.
				} else {
					echo '<input type="text" class="regular-text"' . $common . ' value="' . esc_attr( $value ) . '" maxlength="' . esc_attr( (string) $field['max'] ) . '"' . ( $field['required'] ? ' required' : '' ) . '>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $common is built from escaped parts above.
				}
				break;
			case 'url':
				echo '<input type="text" class="regular-text code" inputmode="url" spellcheck="false"' . $common . ' value="' . esc_attr( $value ) . '" maxlength="500" required>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $common is built from escaped parts above.
				echo '<p class="description">A web address (https://…), an email (mailto:…), a phone number (tel:…) or a place on this page (#…).</p>';
				break;
			case 'image':
				echo '<span class="af-image"><img class="af-image-preview" alt="" src="' . esc_url( self::preview_src( $value, self::$asset_base ) ) . '" data-af-preview>';
				echo '<input type="text" class="regular-text code" spellcheck="false"' . $common . ' value="' . esc_attr( $value ) . '" maxlength="500" required data-af-image>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $common is built from escaped parts above.
				if ( current_user_can( 'upload_files' ) ) {
					echo ' <button type="button" class="button" data-af-pick-image="' . esc_attr( $id ) . '">Choose image…</button>';
				}
				echo '</span>';
				break;
			case 'number':
				echo '<input type="number" class="small-text" min="1" max="99999" step="1"' . $common . ' value="' . esc_attr( $value ) . '" required data-af-dimension="' . esc_attr( $field['attr'] ) . '">'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $common is built from escaped parts above.
				break;
		}
		if ( '' !== $field['help'] ) {
			echo '<p class="description">' . esc_html( $field['help'] ) . '</p>';
		}
		if ( $error ) {
			echo '<p class="af-error" id="' . esc_attr( $id ) . '-error">' . esc_html( $error ) . '</p>';
		}
		echo '</div>';
	}

	/**
	 * Builds the address an image preview loads.
	 *
	 * @param string $value Image field value.
	 * @param string $base  Base URL that relative paths resolve against.
	 * @return string The address, or '' when it cannot be resolved.
	 */
	private static function preview_src( $value, $base ) {
		if ( '' === $value || preg_match( '#^https?://#i', $value ) || '/' === $value[0] ) {
			return $value;
		}
		return '' !== $base ? $base . $value : '';
	}

	/**
	 * Prints a repeatable list: its rows, a template row for "add", and the add button.
	 *
	 * @param array  $field   List definition from the schema.
	 * @param array  $rows    Current rows.
	 * @param array  $pattern Input name pattern.
	 * @param array  $actual  Input name with today's indexes.
	 * @param array  $errors  Error message per path.
	 * @param string $path    Human path.
	 * @param string $id      Element id.
	 * @return void
	 */
	private static function list_field( array $field, array $rows, array $pattern, array $actual, array $errors, $path, $id ) {
		$error = $errors[ $path ] ?? '';
		$label = self::ELEMENT_HINTS[ $field['element'] ] ?? 'Items';
		echo '<div class="af-list' . ( $error ? ' has-error' : '' ) . '" id="' . esc_attr( $id ) . '" data-af-list data-af-name="' . esc_attr( wp_json_encode( $pattern ) ) . '" data-af-min="' . esc_attr( (string) $field['min'] ) . '" data-af-max="' . esc_attr( (string) $field['max'] ) . '">';
		echo '<p class="af-list-title"><strong>' . esc_html( $field['label'] ) . '</strong> <span class="af-key">' . esc_html( sprintf( '%d–%d items', $field['min'], $field['max'] ) ) . '</span></p>';
		if ( $error ) {
			echo '<p class="af-error">' . esc_html( $error ) . '</p>';
		}
		echo '<ol class="af-rows" data-af-rows>';
		foreach ( array_values( $rows ) as $index => $row ) {
			self::row( $field, is_array( $row ) ? $row : array(), array_merge( $pattern, array( null ) ), array_merge( $actual, array( $index ) ), $errors, $path . '[' . $index . ']', $index );
		}
		echo '</ol>';
		// New items start as a copy of the first authored item, so an editor sees the expected shape.
		echo '<template data-af-row-template>';
		self::row( $field, $field['default'][0] ?? array(), array_merge( $pattern, array( null ) ), array_merge( $actual, array( 0 ) ), array(), $path . '[new]', 0 );
		echo '</template>';
		echo '<button type="button" class="button af-add" data-af-add>Add ' . esc_html( strtolower( 'Items' === $label ? 'item' : $label ) ) . '</button>';
		echo '</div>';
	}

	/**
	 * Prints one list row with its move and remove controls.
	 *
	 * @param array  $field   List definition from the schema.
	 * @param array  $row     Row values.
	 * @param array  $pattern Input name pattern.
	 * @param array  $actual  Input name with today's indexes.
	 * @param array  $errors  Error message per path.
	 * @param string $path    Human path.
	 * @param int    $index   Row index.
	 * @return void
	 */
	private static function row( array $field, array $row, array $pattern, array $actual, array $errors, $path, $index ) {
		echo '<li class="af-row" data-af-row><div class="af-row-tools">';
		echo '<span class="af-row-number" aria-hidden="true">' . esc_html( (string) ( $index + 1 ) ) . '</span>';
		echo '<button type="button" class="button-link" data-af-move="-1">Move up</button> <button type="button" class="button-link" data-af-move="1">Move down</button> ';
		echo '<button type="button" class="button-link af-danger" data-af-remove>Remove</button></div>';
		foreach ( $field['item'] as $item ) {
			self::field( $item, $row[ $item['key'] ] ?? $item['default'], array_merge( $pattern, array( $item['key'] ) ), array_merge( $actual, array( $item['key'] ) ), $errors, $path . '.' . $item['key'] );
		}
		echo '</li>';
	}

	/**
	 * Prints the sidebar: version history, hand-off file and "start over".
	 *
	 * @param string                $key      Document key.
	 * @param array                 $state    Document state.
	 * @param Alcor_Fields_Template $template The compiled template.
	 * @return void
	 */
	private static function sidebar( $key, array $state, Alcor_Fields_Template $template ) {
		echo '<aside class="af-side">';
		echo '<div class="af-box"><h2>Versions</h2>';
		if ( ! $state['history'] ) {
			echo '<p>Nothing published yet.</p>';
		} else {
			echo '<ol class="af-history">';
			foreach ( $state['history'] as $entry ) {
				echo '<li><strong>Version ' . esc_html( (string) (int) ( $entry['version'] ?? 0 ) ) . '</strong><br><span>' . esc_html( self::who_when( $entry ) ) . '</span>';
				if ( ! empty( $entry['note'] ) ) {
					echo '<br><em>' . esc_html( (string) $entry['note'] ) . '</em>';
				}
				echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '"><input type="hidden" name="action" value="alcor_fields_restore">';
				echo '<input type="hidden" name="document" value="' . esc_attr( $key ) . '"><input type="hidden" name="af_base_version" value="' . esc_attr( (string) $state['version'] ) . '">';
				echo '<input type="hidden" name="af_version" value="' . esc_attr( (string) (int) ( $entry['version'] ?? 0 ) ) . '">';
				wp_nonce_field( 'alcor_fields_restore_' . $key );
				echo '<button type="submit" class="button-link">Copy to draft</button></form></li>';
			}
			echo '</ol>';
		}
		echo '</div>';
		echo '<div class="af-box"><h2>Hand-off file</h2><p>Download this page&rsquo;s content as a file, or load a file exported from another site with the same design.</p>';
		foreach ( array(
			'published' => 'Download live content',
			'draft'     => 'Download draft',
		) as $which => $label ) {
			if ( 'draft' === $which && ! $state['draft'] ) {
				continue;
			}
			$url = wp_nonce_url(
				add_query_arg(
					array(
						'action'   => 'alcor_fields_export',
						'document' => $key,
						'which'    => $which,
					),
					admin_url( 'admin-post.php' )
				),
				'alcor_fields_export_' . $key
			);
			echo '<p><a class="button" href="' . esc_url( $url ) . '">' . esc_html( $label ) . '</a></p>';
		}
		echo '<form method="post" enctype="multipart/form-data" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '"><input type="hidden" name="action" value="alcor_fields_import">';
		echo '<input type="hidden" name="document" value="' . esc_attr( $key ) . '"><input type="hidden" name="af_base_version" value="' . esc_attr( (string) $state['version'] ) . '">';
		wp_nonce_field( 'alcor_fields_import_' . $key );
		echo '<label for="af-import-file">Load a file into the draft</label><br><input id="af-import-file" type="file" name="af_import_file" accept="application/json,.json" required> ';
		echo '<button type="submit" class="button">Load</button></form></div>';
		echo '<div class="af-box"><h2>Start over</h2><form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		echo '<input type="hidden" name="action" value="alcor_fields_save"><input type="hidden" name="document" value="' . esc_attr( $key ) . '">';
		echo '<input type="hidden" name="af_base_version" value="' . esc_attr( (string) $state['version'] ) . '"><input type="hidden" name="af[complete]" value="1">';
		wp_nonce_field( 'alcor_fields_save_' . $key );
		echo '<p>Put the original design&rsquo;s content into the draft. Nothing changes on the live page until you publish.</p>';
		echo '<button type="submit" class="button" name="af_action" value="reset" data-af-confirm="Replace the draft with the original content?">Reset draft to original</button></form>';
		echo '<p class="af-key">Template ' . esc_html( substr( $template->sha256, 0, 12 ) ) . ' · stored version ' . esc_html( (string) $state['version'] ) . '</p></div>';
		echo '</aside>';
	}

	/* ------------------------------------------------------------------ actions */

	/**
	 * Reads a posted whole number.
	 *
	 * @param string $name POST field name.
	 * @return int The number, or -1 when it is missing or not 1 to 9 digits.
	 */
	private static function post_int( $name ) {
		return isset( $_POST[ $name ] ) && is_string( $_POST[ $name ] ) && preg_match( '/^[0-9]{1,9}$/', $_POST[ $name ] ) ? (int) $_POST[ $name ] : -1; // phpcs:ignore WordPress.Security.NonceVerification.Missing,WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- every caller has passed check_admin_referer(); the value is matched against digits only.
	}

	/**
	 * Redirects back to the editor and ends the request.
	 *
	 * @param string $key  Document key.
	 * @param array  $args Query arguments to add.
	 * @return void
	 */
	private static function back( $key, array $args = array() ) {
		wp_safe_redirect( self::url( array( 'document' => $key ) + $args ) );
		exit;
	}

	/**
	 * Keeps the editor's input and the problems for the next page view, then redirects back.
	 *
	 * @param string     $key     Document key.
	 * @param array|null $doc     What the editor submitted, to show again.
	 * @param array      $errors  Problems, each with a path and a message.
	 * @param string     $message Overall message.
	 * @return void
	 */
	private static function fail( $key, $doc, array $errors, $message = '' ) {
		set_transient(
			self::flash_key( $key ),
			array(
				'errors'  => $errors,
				'doc'     => $doc,
				'message' => $message,
			),
			10 * MINUTE_IN_SECONDS
		);
		self::back( $key, array( 'af_error' => 1 ) );
	}

	/**
	 * Turns the posted form (or admin.js's JSON) into a document in the template's shape.
	 *
	 * @param Alcor_Fields_Template $template The compiled template.
	 * @param array                 $raw      The posted "af" array.
	 * @return array values and hidden.
	 */
	private static function doc_from_post( Alcor_Fields_Template $template, array $raw ) {
		$values = isset( $raw['v'] ) && is_array( $raw['v'] ) ? $raw['v'] : array();
		$shown  = isset( $raw['shown'] ) && is_array( $raw['shown'] ) ? $raw['shown'] : array();
		$hidden = array();
		foreach ( $template->sections as $key => $section ) {
			if ( ! $section['required'] && empty( $shown[ $key ] ) ) {
				$hidden[] = $key;
			}
		}
		$shape = static function ( array $defs, array $in ) use ( &$shape ) {
			$out = array();
			foreach ( $in as $key => $value ) {
				$key = (string) $key;
				if ( ! isset( $defs[ $key ] ) ) {
					$out[ $key ] = $value;
					continue;
				}
				if ( 'list' === $defs[ $key ]['type'] ) {
					$rows = array();
					foreach ( is_array( $value ) ? array_values( $value ) : array() as $row ) {
						$row = is_array( $row ) ? $row : array();
						foreach ( $defs[ $key ]['item'] as $item_key => $item_def ) {
							if ( 'list' === $item_def['type'] && ! isset( $row[ $item_key ] ) ) {
								$row[ $item_key ] = array();
							}
						}
						$rows[] = $shape( $defs[ $key ]['item'], $row );
					}
					$out[ $key ] = $rows;
				} else {
					$out[ $key ] = is_scalar( $value ) ? (string) $value : $value;
				}
			}
			return $out;
		};
		return array(
			'values' => $shape( $template->fields, $values ),
			'hidden' => $hidden,
		);
	}

	/**
	 * Handles Save draft, Publish, Discard and Reset.
	 *
	 * @return void
	 */
	public static function handle_save() {
		$key = self::require_document();
		check_admin_referer( 'alcor_fields_save_' . $key );
		$action   = isset( $_POST['af_action'] ) && is_string( $_POST['af_action'] ) ? sanitize_key( wp_unslash( $_POST['af_action'] ) ) : 'draft';
		$base     = self::post_int( 'af_base_version' );
		$template = alcor_fields_template( $key );
		$raw      = isset( $_POST['af'] ) && is_array( $_POST['af'] ) ? wp_unslash( $_POST['af'] ) : array(); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- validated field by field by the template below.
		$json     = isset( $_POST['af_json'] ) && is_string( $_POST['af_json'] ) ? wp_unslash( $_POST['af_json'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- decoded, then validated field by field by the template below.
		if ( '' !== $json ) {
			$decoded = json_decode( $json, true );
			if ( ! is_array( $decoded ) ) {
				self::fail( $key, null, array(), 'The form could not be read. Nothing was saved.' );
			}
			$raw = $decoded;
		}
		if ( empty( $raw['complete'] ) ) {
			self::fail( $key, null, array(), 'The form arrived incomplete (the server limits how many fields one form may send), so nothing was saved. Turn on JavaScript, or ask your host to raise max_input_vars.' );
		}
		$doc = in_array( $action, array( 'draft', 'publish' ), true ) ? self::doc_from_post( $template, $raw ) : null;
		try {
			if ( 'draft' === $action ) {
				Alcor_Fields_Store::save_draft( $key, $base, $template->validate( $doc, alcor_fields_env() ) );
			} elseif ( 'publish' === $action ) {
				Alcor_Fields_Store::publish( $key, $base, $template->validate( $doc, alcor_fields_env() ) );
			} elseif ( 'discard' === $action ) {
				Alcor_Fields_Store::discard_draft( $key, $base );
			} elseif ( 'reset' === $action ) {
				Alcor_Fields_Store::save_draft(
					$key,
					$base,
					array(
						'values' => array(),
						'hidden' => array(),
					),
					'Reset to original'
				);
			} else {
				self::fail( $key, $doc, array(), 'Unknown action.' );
			}
		} catch ( Alcor_Fields_Error $e ) {
			self::fail( $key, $doc, $e->errors );
		} catch ( Alcor_Fields_Conflict $e ) {
			self::fail( $key, $doc, array(), $e->getMessage() . ' Your edits are kept below; publish or save again to replace that version.' );
		} catch ( Throwable $e ) {
			self::fail( $key, $doc, array(), 'Nothing was saved: ' . $e->getMessage() );
		}
		self::back( $key, array( 'af_msg' => $action ) );
	}

	/**
	 * Handles "Copy to draft" on a history entry.
	 *
	 * @return void
	 */
	public static function handle_restore() {
		$key = self::require_document();
		check_admin_referer( 'alcor_fields_restore_' . $key );
		try {
			Alcor_Fields_Store::restore( $key, self::post_int( 'af_base_version' ), self::post_int( 'af_version' ) );
		} catch ( Alcor_Fields_Error $e ) {
			self::fail( $key, null, $e->errors, 'That version no longer fits this page’s design.' );
		} catch ( Alcor_Fields_Conflict $e ) {
			self::fail( $key, null, array(), $e->getMessage() );
		} catch ( Throwable $e ) {
			self::fail( $key, null, array(), 'Nothing was changed: ' . $e->getMessage() );
		}
		self::back( $key, array( 'af_msg' => 'restore' ) );
	}

	/**
	 * Handles loading a hand-off file into the draft.
	 *
	 * @return void
	 */
	public static function handle_import() {
		$key = self::require_document();
		check_admin_referer( 'alcor_fields_import_' . $key );
		$file = $_FILES['af_import_file'] ?? null; // phpcs:ignore WordPress.Security.NonceVerification.Missing,WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- nonce checked above; the file is only read after is_uploaded_file() and its JSON is validated by the template.
		if ( ! is_array( $file ) || UPLOAD_ERR_OK !== (int) ( $file['error'] ?? 1 ) || ! is_uploaded_file( (string) $file['tmp_name'] ) ) {
			self::fail( $key, null, array(), 'No file was uploaded.' );
		}
		if ( (int) $file['size'] > 2 * MB_IN_BYTES ) {
			self::fail( $key, null, array(), 'That file is larger than 2 MB; an AlcorFields export never is.' );
		}
		$export = json_decode( (string) file_get_contents( (string) $file['tmp_name'] ), true );
		try {
			$clean = alcor_fields_import_document( $key, $export );
			Alcor_Fields_Store::save_draft( $key, self::post_int( 'af_base_version' ), $clean, 'Imported from file' );
		} catch ( Alcor_Fields_Error $e ) {
			self::fail( $key, null, $e->errors, 'The file was not loaded.' );
		} catch ( Alcor_Fields_Conflict $e ) {
			self::fail( $key, null, array(), $e->getMessage() );
		} catch ( Throwable $e ) {
			self::fail( $key, null, array(), 'The file was not loaded: ' . $e->getMessage() );
		}
		self::back( $key, array( 'af_msg' => 'import' ) );
	}

	/**
	 * Handles "Set aside and start over" for a document whose stored row is unreadable (administrators only).
	 *
	 * @return void
	 */
	public static function handle_quarantine() {
		$key = self::require_document();
		check_admin_referer( 'alcor_fields_quarantine_' . $key );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You cannot do that.' ), 403 );
		}
		$kept = Alcor_Fields_Store::quarantine( $key );
		set_transient(
			self::flash_key( $key ),
			array( 'message' => $kept ? 'The unreadable content was set aside as option ' . $kept . '. This page now starts from its original content.' : 'Nothing needed setting aside.' ),
			10 * MINUTE_IN_SECONDS
		);
		self::back( $key );
	}

	/**
	 * Handles the hand-off file download.
	 *
	 * @return void
	 */
	public static function handle_export() {
		$key = self::require_document();
		check_admin_referer( 'alcor_fields_export_' . $key );
		$which = isset( $_GET['which'] ) && 'draft' === $_GET['which'] ? 'draft' : 'published'; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- nonce checked above.
		try {
			$export = alcor_fields_export( $key, $which );
		} catch ( Throwable $e ) {
			wp_die( esc_html( 'This content cannot be exported right now: ' . $e->getMessage() ), 500 );
		}
		nocache_headers();
		header( 'Content-Type: application/json; charset=utf-8' );
		header( 'X-Content-Type-Options: nosniff' );
		header( 'Content-Disposition: attachment; filename="' . $key . '-' . $export['state'] . '-v' . $export['version'] . '.json"' );
		echo wp_json_encode( $export, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- JSON download, not HTML.
		exit;
	}
}
